const DEXPAPRIKA_BASE = 'https://api.dexpaprika.com';
const { fetchPair } = require('../sources/source-rotator');

async function fetchGranularActivity(tokenAddress) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${DEXPAPRIKA_BASE}/networks/solana/tokens/${tokenAddress}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const s = data.summary;
    if (!s) return null;
    return {
      '5m': { buys: s['5m']?.buys || 0, sells: s['5m']?.sells || 0, txns: s['5m']?.txns || 0, vol: s['5m']?.volume_usd || 0 },
      '15m': { buys: s['15m']?.buys || 0, sells: s['15m']?.sells || 0, txns: s['15m']?.txns || 0, vol: s['15m']?.volume_usd || 0 },
      '1h': { buys: s['1h']?.buys || 0, sells: s['1h']?.sells || 0, txns: s['1h']?.txns || 0, vol: s['1h']?.volume_usd || 0 },
      liquidity_usd: s.liquidity_usd || 0
    };
  } catch (_) { return null; }
}

async function checkVitality(tokenAddress, dexscreenerPair) {
  const result = {
    isAlive: false,
    isDead: false,
    reasons: [],
    signals: [],
    buySellRatio: 0.5,
    recentTxns: 0,
    momentum: 'unknown'
  };

  // 0. Fetch pair data if not provided
  if (!dexscreenerPair) {
    try {
      dexscreenerPair = await fetchPair(tokenAddress);
    } catch (_) {}
  }

  // 1. DexScreener pair data (most immediate)
  if (dexscreenerPair) {
    const txns = dexscreenerPair.txns || {};
    const h1Buys = txns.h1?.buys || 0;
    const h1Sells = txns.h1?.sells || 0;
    const h1Total = h1Buys + h1Sells;

    if (h1Total > 0) {
      result.buySellRatio = h1Buys / h1Total;
      result.recentTxns = h1Total;
    }

    const liq = dexscreenerPair.liquidity?.usd || 0;
    const volH24 = dexscreenerPair.volume?.h24 || 0;
    const volH1 = dexscreenerPair.volume?.h1 || 0;

    if (liq < 50) { result.isDead = true; result.reasons.push('Liq < $50'); }
    if (h1Total < 3 && h1Sells === 0) { result.isDead = true; result.reasons.push('No recent txns'); }
    if (h1Total >= 5 && result.buySellRatio < 0.25) { result.isDead = true; result.reasons.push(`${(result.buySellRatio * 100).toFixed(0)}% buys (all sells)`); }
    if (volH24 > 10000 && volH1 < 50) { result.isDead = true; result.reasons.push('Volume dried'); }

    if (h1Total >= 10 && result.buySellRatio > 0.35) {
      result.isAlive = true;
      result.signals.push(`${h1Total} txns/h, ${(result.buySellRatio * 100).toFixed(0)}% buys`);
    }
    if (volH1 > 500) {
      result.signals.push(`$${volH1}/h vol`);
      if (!result.isDead) result.isAlive = true;
    }
  }

  // 2. DexPaprika granular data (5m window — most real-time)
  const paprika = await fetchGranularActivity(tokenAddress);
  if (paprika) {
    const m5 = paprika['5m'];
    const h1 = paprika['1h'];

    if (m5.txns >= 3) {
      const ratio5m = m5.buys / (m5.buys + m5.sells || 1);
      if (ratio5m < 0.2) { result.isDead = true; result.reasons.push(`5m: ${m5.buys}B/${m5.sells}S (dumping now)`); }
      if (ratio5m > 0.4) { result.signals.push(`5m: ${m5.txns} txns, ${(ratio5m * 100).toFixed(0)}% buys`); if (!result.isDead) result.isAlive = true; }
    } else if (m5.txns === 0 && h1.txns > 0) {
      result.isDead = true;
      result.reasons.push('Zero activity in last 5 min');
    }

    if (h1.txns >= 15 && h1.buys / (h1.buys + h1.sells || 1) > 0.35) {
      if (!result.isDead) result.isAlive = true;
    }

    if (paprika.liquidity_usd > 0 && paprika.liquidity_usd < 30) {
      result.isDead = true;
      result.reasons.push('Liq dried');
    }
  }

  // 3. Final
  if (result.isAlive && !result.isDead) {
    result.momentum = 'active';
  } else if (result.isDead) {
    result.momentum = 'dead';
  } else {
    result.momentum = 'uncertain';
  }

  return result;
}

module.exports = { checkVitality };
