const { rateLimitedFetch } = require('../utils/dex-rate-limit');

async function fetchTokenData(tokenAddress) {
  const res = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  if (!res || !res.ok) return null;
  const data = await res.json();
  const pair = data.pairs?.[0];
  if (!pair) return null;
  return {
    priceUsd: parseFloat(pair.priceUsd) || 0,
    fdv: pair.fdv || 0,
    liquidityUsd: pair.liquidity?.usd || 0,
    vol5m: pair.volume?.m5 || 0,
    vol1h: pair.volume?.h1 || 0,
    vol24h: pair.volume?.h24 || 0,
    buys5m: pair.txns?.m5?.buys || 0,
    sells5m: pair.txns?.m5?.sells || 0,
    txns5m: (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0),
    buys1h: pair.txns?.h1?.buys || 0,
    sells1h: pair.txns?.h1?.sells || 0,
    priceChange5m: pair.priceChange?.m5 || 0,
    priceChange1h: pair.priceChange?.h1 || 0,
    symbol: pair.baseToken?.symbol || null,
    name: pair.baseToken?.name || null,
    pairCreatedAt: pair.pairCreatedAt || null,
    dexId: pair.dexId || null,
    source: 'dexscreener'
  };
}

async function fetchNewProfiles() {
  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(8000) });
    if (!res || !res.ok) return [];
    return await res.json();
  } catch { return []; }
}

module.exports = { fetchTokenData, fetchNewProfiles, name: 'dexscreener' };
