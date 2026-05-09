const { fetchDexVolume, fetchAllNewTokens, fetchSearchPairs } = require('../sources/source-rotator');
const copyTrader = require('../agents/copy-trader');
const { isRecentlySold } = require('./momentum-trader');

const SCAN_INTERVAL = 15000; // 15s for near-instant sniping

const volumeHistory = new Map();
let seenTokens = new Map(); // addr -> timestamp (TTL-based)
const zeroTxnCooldown = new Map(); // addr -> timestamp, cleared after 60s

// Well-known non-memecoin addresses — skip these
const KNOWN_NON_MEME = new Set([
  'So11111111111111111111111111111111111111112', // Wrapped SOL
  'EPjFWdd5AufqSSqeM2Rq4Qj4S4oGf6Yf7zG4z3z3z3z3', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  '7GCihgDB8fe6KNjn2MYtkzZcRj12u6T6GcECpK8ZBo5F', // POPCAT
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  '2weMjPLLybRMMva1fM3U31goWWrCpF59CHWNhnCJ9Vyh', // dogwifhat
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3K6fi5Fb8umi7EQ', // mSOL
  'J1toso1uCk3QLmjykT3ctL1A4EJukp4zq1K9PmCHqZR', // JitoSOL
]);
function isKnownNonMeme(addr) { return KNOWN_NON_MEME.has(addr); }
// TTL-based seenTokens: each entry is {addr, time} instead of a flat Set
const SEEN_TTL = 600000; // 10 min — don't re-trigger same token within 10 min
let seenClearedAt = Date.now();
const SEEN_CLEAN_INTERVAL = 60000; // clean stale entries every 60s

// Minimum thresholds for sniping (blind buys)
const MIN_SNIPE_TXNS = 3;       // at least 3 transactions in 5m
const MIN_SNIPE_VOL_USD = 50;   // at least $50 volume in 5m (DexScreener returns USD)

function checkMomentum(address, paprika) {
  const history = volumeHistory.get(address) || [];
  history.push({ time: Date.now(), vol5m: paprika.vol5m, buys5m: paprika.buys5m, sells5m: paprika.sells5m });
  if (history.length > 10) history.shift();
  volumeHistory.set(address, history);

  const latest = history[history.length - 1];
  const buyRatio = (latest.buys5m + latest.sells5m) > 0 ? latest.buys5m / (latest.buys5m + latest.sells5m) : 0;
  const totalTxns5m = latest.buys5m + latest.sells5m;

  if (history.length < 2) {
    if (totalTxns5m >= 3 && buyRatio >= 0.5) {
      return { trigger: 'first_activity', buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `${totalTxns5m} txns, ${(buyRatio * 100).toFixed(0)}% buys` };
    }
    return null;
  }

  const prev = history[history.length - 2];
  const volSpike = prev.vol5m > 0 ? latest.vol5m / prev.vol5m : (latest.vol5m > 0 ? 999 : 0);

  if (totalTxns5m >= 3 && buyRatio >= 0.5 && volSpike >= 2) {
    return { trigger: 'strong', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `vol spike ${volSpike.toFixed(1)}x` };
  }
  if (totalTxns5m >= 5 && buyRatio >= 0.6) {
    return { trigger: 'buy_pressure', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `${(buyRatio * 100).toFixed(0)}% buys` };
  }
  if (totalTxns5m >= 10 && buyRatio >= 0.4) {
    return { trigger: 'high_activity', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `${totalTxns5m} txns/5m` };
  }
  return null;
}

async function scanMomentum() {
  // Prune stale seen entries instead of clearing everything (prevents trigger bursts)
  if (Date.now() - seenClearedAt > SEEN_CLEAN_INTERVAL) {
    for (const [addr, ts] of seenTokens) {
      if (Date.now() - ts > SEEN_TTL) seenTokens.delete(addr);
    }
    seenClearedAt = Date.now();
  }

  const triggers = [];

  // Clean expired zeroTxnCooldown entries
  for (const [addr, ts] of zeroTxnCooldown) {
    if (Date.now() - ts > 60000) zeroTxnCooldown.delete(addr);
  }

  // PATH 1: Multi-source token profiles — new launch detection for sniping
  const profiles = await fetchAllNewTokens();
  for (const profile of (profiles || []).slice(0, 50)) {
    const addr = profile.tokenAddress;
    if (!addr || addr.startsWith('0x') || addr.length < 32 || addr.length > 44) continue;
    if (isKnownNonMeme(addr)) continue;
    if (seenTokens.has(addr)) continue;
    if (zeroTxnCooldown.has(addr)) continue;

    const deployer = profile.creator || null;
    const paprika = await fetchDexVolume(addr);
    if (!paprika) continue;

    // Resolve symbol: profile first, fallback to source data
    const resolvedSymbol = profile.symbol || paprika.symbol || '?';
    const resolvedName = profile.name || paprika.baseToken || '';

    // 0-txn tokens: first time gets 60s grace, then moves to 10min seenTokens
    if (paprika.txns5m === 0) {
      if (zeroTxnCooldown.has(addr)) {
        seenTokens.set(addr, Date.now()); // still dead after grace — check again in 10min
      } else {
        zeroTxnCooldown.set(addr, Date.now()); // first check — give 60s for first txns
      }
      continue;
    }

    // Check if we already have an open position or recent trade for this token
    const existingPos = [...require('./momentum-trader').activePositions.values()].find(p => p.tokenAddress === addr);
    if (existingPos) continue;

    seenTokens.set(addr, Date.now());

    const momentum = checkMomentum(addr, paprika);

    // Copy trade check
    let copyTradeSignal = null;
    if (deployer) {
      const profitable = await copyTrader.isProfitableDeployer(deployer);
      if (profitable) copyTradeSignal = { wallet: deployer, reason: `profitable deployer (score:${profitable.score})`, score: profitable.score };
      copyTrader.observeToken(addr, deployer, resolvedSymbol, null);
    }

    // Only trigger if there's real activity or a profitable deployer
    const hasRealActivity = paprika.txns5m >= MIN_SNIPE_TXNS && paprika.vol5m >= MIN_SNIPE_VOL_USD;
    const hasCopySignal = copyTradeSignal && copyTradeSignal.score > 15;

    if (!momentum && !hasRealActivity && !hasCopySignal) {
      // Low quality — skip instead of blind sniping
      zeroTxnCooldown.set(addr, Date.now());
      continue;
    }

    triggers.push({
      address: addr,
      symbol: resolvedSymbol,
      name: resolvedName,
      momentum: momentum || { trigger: 'snipe', reason: `activity ${paprika.txns5m}txns $${paprika.vol5m} vol`, buyRatio: 0, totalTxns5m: paprika.txns5m, vol5m: paprika.vol5m },
      paprika,
      copyTradeSignal,
      deployer,
      isSnipe: !momentum
    });
  }

  // PATH 2: Search API — finds active pairs already trading
  const pairs = await fetchSearchPairs();
  for (const pair of (pairs || []).slice(0, 10)) {
    const addr = pair.baseToken?.address;
    if (!addr || addr.startsWith('0x') || addr.length < 32 || addr.length > 44) continue;
    if (isKnownNonMeme(addr)) continue;
    if (seenTokens.has(addr)) continue;
    if (isRecentlySold(addr)) continue;
    seenTokens.set(addr, Date.now());

    // Skip tokens older than 30 min — focus on fresh launches
    const ageMin = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60000 : 0;
    if (ageMin > 30) continue;

    const mc = pair.fdv || 0;
    if (mc > 9000) continue;
    const volH1 = pair.volume?.h1 || 0;
    if (volH1 < 50) continue;

    const paprika = await fetchDexVolume(addr);
    if (!paprika || paprika.txns5m < 2) continue;

    // Check existing positions before triggering
    const existingPos = [...require('./momentum-trader').activePositions.values()].find(p => p.tokenAddress === addr);
    if (existingPos) continue;

    const momentum = checkMomentum(addr, paprika);
    if (momentum) {
      triggers.push({
        address: addr, symbol: pair.baseToken?.symbol || '?', name: pair.baseToken?.name || '',
        momentum, paprika, copyTradeSignal: null, deployer: null, isSnipe: false
      });
    }
  }

  if (triggers.length) {
    const labels = triggers.map(t => `${t.symbol}(${t.momentum.trigger})`).join(', ');
    console.log(`[Momentum] ${triggers.length} trigger(s): ${labels}`);
  }

  return triggers;
}

async function startMomentumScanner(onTrigger) {
  console.log('[Momentum] Starting sniping + momentum scanner (every 15s)...');
  copyTrader.seedFromGMGN();
  const scan = async () => {
    try {
      const triggers = await scanMomentum();
      for (const t of triggers) {
        if (onTrigger) await onTrigger(t);
      }
    } catch (e) {
      console.error('[Momentum] Scan error:', e.message);
    }
  };
  await scan();
  setInterval(scan, SCAN_INTERVAL);
}

module.exports = { startMomentumScanner, scanMomentum };
