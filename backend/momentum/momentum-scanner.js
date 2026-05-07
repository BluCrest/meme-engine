const { fetchWithRetry } = require('../utils/http-client');
const copyTrader = require('../agents/copy-trader');

const SCAN_INTERVAL = 15000; // 15s for near-instant sniping
const DEXPAPRIKA_BASE = 'https://api.dexpaprika.com';

const volumeHistory = new Map();
let seenTokens = new Set();
let seenClearedAt = Date.now();
const SEEN_CLEAR_INTERVAL = 300000;

async function fetchPaprikaVolume(tokenAddress) {
  try {
    const res = await fetchWithRetry(`${DEXPAPRIKA_BASE}/networks/solana/tokens/${tokenAddress}`, { timeout: 6000 });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const s = data.summary;
    if (!s) return null;
    return {
      vol5m: s['5m']?.volume_usd || 0,
      buys5m: s['5m']?.buys || 0,
      sells5m: s['5m']?.sells || 0,
      txns5m: s['5m']?.txns || 0,
      vol1h: s['1h']?.volume_usd || 0
    };
  } catch (_) { return null; }
}

async function fetchTokenProfiles() {
  try {
    const res = await fetchWithRetry('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 8000, retryDelay: 2000 });
    if (!res || !res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

async function fetchSearchPairs() {
  try {
    const res = await fetchWithRetry('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 8000, retryDelay: 2000 });
    if (!res || !res.ok) return [];
    const data = await res.json();
    return data.pairs || [];
  } catch (_) { return []; }
}

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
  if (Date.now() - seenClearedAt > SEEN_CLEAR_INTERVAL) {
    seenTokens = new Set();
    seenClearedAt = Date.now();
  }

  const triggers = [];

  // PATH 1: Token profiles — new launch detection for sniping
  const profiles = await fetchTokenProfiles();
  for (const profile of (profiles || []).slice(0, 50)) {
    const addr = profile.tokenAddress;
    if (!addr || addr.length < 32 || addr.length > 44) continue;

    const isNew = !seenTokens.has(addr);
    seenTokens.add(addr);
    if (!isNew) continue;

    const deployer = profile.creator?.address || null;
    const paprika = await fetchPaprikaVolume(addr);
    if (!paprika) continue;

    const momentum = paprika.txns5m >= 1 ? checkMomentum(addr, paprika) : null;

    // Copy trade check
    let copyTradeSignal = null;
    if (deployer) {
      const profitable = await copyTrader.isProfitableDeployer(deployer);
      if (profitable) copyTradeSignal = { wallet: deployer, reason: `profitable deployer (score:${profitable.score})`, score: profitable.score };
      copyTrader.observeToken(addr, deployer, profile.symbol || '?', null);
    }

    // SNIPE: every new token gets bought immediately (if we have capacity)
    triggers.push({
      address: addr,
      symbol: profile.symbol || '?',
      name: profile.name || '',
      momentum: momentum || { trigger: 'snipe', reason: 'new launch', buyRatio: 0, totalTxns5m: 0, vol5m: 0 },
      paprika,
      copyTradeSignal,
      deployer,
      isSnipe: !momentum // snipe if no momentum data yet
    });
  }

  // PATH 2: Search API — finds active pairs already trading
  const pairs = await fetchSearchPairs();
  for (const pair of (pairs || []).slice(0, 30)) {
    const addr = pair.baseToken?.address;
    if (!addr || addr.length < 32 || addr.length > 44) continue;
    if (seenTokens.has(addr)) continue;
    seenTokens.add(addr);

    const mc = pair.fdv || 0;
    if (mc > 50000) continue;
    const volH1 = pair.volume?.h1 || 0;
    if (volH1 < 50) continue;

    const paprika = await fetchPaprikaVolume(addr);
    if (!paprika || paprika.txns5m < 2) continue;

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
