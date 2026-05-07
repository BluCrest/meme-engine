const db = require('../database/db');

const SCAN_INTERVAL = 60000;
const DEXPAPRIKA_BASE = 'https://api.dexpaprika.com';

// Rolling history of volume per token: { address: [{ time, vol5m, buys5m, sells5m }, ...] }
const volumeHistory = new Map();
const seenTokens = new Set();

function getRecentActivity(tokenAddress) {
  const history = volumeHistory.get(tokenAddress);
  if (!history || history.length < 2) return null;
  const latest = history[history.length - 1];
  const prev = history[history.length - 2];
  const volSpike = prev.vol5m > 0 ? latest.vol5m / prev.vol5m : 0;
  return { latest, prev, volSpike };
}

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
      vol1h: s['1h']?.volume_usd || 0,
      buys1h: s['1h']?.buys || 0,
      sells1h: s['1h']?.sells || 0
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

function checkMomentum(address, paprika) {
  const history = volumeHistory.get(address) || [];
  history.push({ time: Date.now(), vol5m: paprika.vol5m, buys5m: paprika.buys5m, sells5m: paprika.sells5m });
  if (history.length > 10) history.shift();
  volumeHistory.set(address, history);

  if (history.length < 2) return null;

  const latest = history[history.length - 1];
  const prev = history[history.length - 2];

  const volSpike = prev.vol5m > 0 ? latest.vol5m / prev.vol5m : (latest.vol5m > 0 ? 999 : 0);
  const buyRatio = (latest.buys5m + latest.sells5m) > 0 ? latest.buys5m / (latest.buys5m + latest.sells5m) : 0;
  const totalTxns5m = latest.buys5m + latest.sells5m;

  // Momentum trigger: vol spike OR strong buy pressure WITH transactions
  if (totalTxns5m >= 3 && buyRatio >= 0.5 && volSpike >= 2) {
    return { trigger: 'strong', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `vol spike ${volSpike.toFixed(1)}x, ${(buyRatio * 100).toFixed(0)}% buys, ${totalTxns5m} txns` };
  }

  if (totalTxns5m >= 5 && buyRatio >= 0.6) {
    return { trigger: 'buy_pressure', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `buy pressure ${(buyRatio * 100).toFixed(0)}% buys, ${totalTxns5m} txns` };
  }

  if (totalTxns5m >= 10 && buyRatio >= 0.4) {
    return { trigger: 'high_activity', volSpike, buyRatio, totalTxns5m, vol5m: latest.vol5m, reason: `${totalTxns5m} txns/5m, ${(buyRatio * 100).toFixed(0)}% buys` };
  }

  return null;
}

async function scanMomentum() {
  const profiles = await fetchTokenProfiles();
  if (!profiles.length) return [];

  const triggers = [];

  for (const profile of profiles.slice(0, 30)) {
    const addr = profile.tokenAddress;
    if (!addr || addr.length < 32 || addr.length > 44) continue;
    if (seenTokens.has(addr)) continue;
    seenTokens.add(addr);

    const paprika = await fetchPaprikaVolume(addr);
    if (!paprika || paprika.txns5m < 2) continue;

    const momentum = checkMomentum(addr, paprika);
    if (momentum) {
      triggers.push({
        address: addr,
        symbol: profile.symbol || '?',
        name: profile.name || '',
        momentum,
        paprika
      });
    }
  }

  if (triggers.length) {
    console.log(`[Momentum] ${triggers.length} trigger(s): ${triggers.map(t => `${t.symbol}(${t.momentum.trigger})`).join(', ')}`);
  }

  return triggers;
}

async function startMomentumScanner(onTrigger) {
  console.log('[Momentum] Starting momentum scanner (every 60s)...');
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
