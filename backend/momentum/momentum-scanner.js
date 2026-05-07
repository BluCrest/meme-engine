const db = require('../database/db');
const copyTrader = require('../agents/copy-trader');

const SCAN_INTERVAL = 20000;
const DEXPAPRIKA_BASE = 'https://api.dexpaprika.com';

const volumeHistory = new Map();
let seenTokens = new Set();
let seenClearedAt = Date.now();
const SEEN_CLEAR_INTERVAL = 300000; // re-check old tokens every 5 min

async function fetchPaprikaVolume(tokenAddress) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${DEXPAPRIKA_BASE}/networks/solana/tokens/${tokenAddress}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
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
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    if (!res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

async function fetchSearchPairs() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
    if (!res.ok) return [];
    const data = await res.json();
    return data.pairs || [];
  } catch (_) { return []; }
}

function checkMomentum(address, paprika) {
  const history = volumeHistory.get(address) || [];
  history.push({ time: Date.now(), vol5m: paprika.vol5m, buys5m: paprika.buys5m, sells5m: paprika.sells5m });
  if (history.length > 10) history.shift();
  volumeHistory.set(address, history);

  if (history.length < 2) {
    // First sighting: if there's already some activity, trigger
    if (paprika.txns5m >= 3 && paprika.buys5m > paprika.sells5m) {
      return { trigger: 'first_activity', volSpike: 0, buyRatio: paprika.buys5m / (paprika.buys5m + paprika.sells5m || 1), totalTxns5m: paprika.txns5m, vol5m: paprika.vol5m, reason: `first activity: ${paprika.txns5m} txns` };
    }
    return null;
  }

  const latest = history[history.length - 1];
  const prev = history[history.length - 2];

  const volSpike = prev.vol5m > 0 ? latest.vol5m / prev.vol5m : (latest.vol5m > 0 ? 999 : 0);
  const buyRatio = (latest.buys5m + latest.sells5m) > 0 ? latest.buys5m / (latest.buys5m + latest.sells5m) : 0;
  const totalTxns5m = latest.buys5m + latest.sells5m;

  if (totalTxns5m >= 3 && buyRatio >= 0.5 && volSpike >= 2) {
    return { trigger: 'strong', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `vol spike ${volSpike.toFixed(1)}x` };
  }
  if (totalTxns5m >= 5 && buyRatio >= 0.6) {
    return { trigger: 'buy_pressure', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `${(buyRatio * 100).toFixed(0)}% buys` };
  }
  if (totalTxns5m >= 10 && buyRatio >= 0.4) {
    return { trigger: 'high_activity', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `${totalTxns5m} txns` };
  }
  return null;
}

async function scanMomentum() {
  // Clear seen set periodically to re-check old tokens
  if (Date.now() - seenClearedAt > SEEN_CLEAR_INTERVAL) {
    seenTokens = new Set();
    seenClearedAt = Date.now();
  }

  const triggers = [];

  // Path 1: New token profiles (fast launch detection)
  const profiles = await fetchTokenProfiles();
  for (const profile of (profiles || []).slice(0, 40)) {
    const addr = profile.tokenAddress;
    if (!addr || addr.length < 32 || addr.length > 44) continue;
    if (seenTokens.has(addr)) continue;
    seenTokens.add(addr);

    const deployer = profile.creator?.address || null;
    const paprika = await fetchPaprikaVolume(addr);
    if (!paprika || paprika.txns5m < 1) continue;

    const momentum = checkMomentum(addr, paprika);

    let copyTradeSignal = null;
    if (deployer) {
      const profitable = await copyTrader.isProfitableDeployer(deployer);
      if (profitable) {
        copyTradeSignal = { wallet: deployer, reason: `known profitable deployer (score:${profitable.score})`, score: profitable.score };
      }
      copyTrader.observeToken(addr, deployer, profile.symbol || '?', null);
    }

    if (copyTradeSignal && !momentum) {
      triggers.push({
        address: addr, symbol: profile.symbol || '?', name: profile.name || '',
        momentum: { trigger: 'copy_trade', reason: copyTradeSignal.reason, volSpike: 0, buyRatio: paprika.buys5m / (paprika.buys5m + paprika.sells5m || 1), totalTxns5m: paprika.txns5m, vol5m: paprika.vol5m },
        paprika, copyTradeSignal
      });
      continue;
    }

    if (momentum) {
      triggers.push({ address: addr, symbol: profile.symbol || '?', name: profile.name || '', momentum, paprika, copyTradeSignal, deployer });
    }
  }

  // Path 2: Search API for active pairs (catches tokens with exchange activity already)
  const pairs = await fetchSearchPairs();
  for (const pair of (pairs || []).slice(0, 30)) {
    const addr = pair.baseToken?.address;
    if (!addr || addr.length < 32 || addr.length > 44) continue;
    if (seenTokens.has(addr)) continue;
    seenTokens.add(addr);

    const mc = pair.fdv || 0;
    if (mc > 100000) continue;
    const volH1 = pair.volume?.h1 || 0;
    if (volH1 < 100) continue;

    const paprika = await fetchPaprikaVolume(addr);
    if (!paprika || paprika.txns5m < 2) continue;

    const momentum = checkMomentum(addr, paprika);
    if (momentum) {
      triggers.push({
        address: addr, symbol: pair.baseToken?.symbol || '?', name: pair.baseToken?.name || '',
        momentum, paprika, copyTradeSignal: null, deployer: null
      });
    }
  }

  if (triggers.length) {
    console.log(`[Momentum] ${triggers.length} trigger(s): ${triggers.map(t => `${t.symbol}(${t.momentum.trigger})`).join(', ')}`);
  }

  return triggers;
}

async function startMomentumScanner(onTrigger) {
  console.log('[Momentum] Starting momentum scanner (every 20s, 2 scan paths)...');
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
