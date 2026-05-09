const BASE = 'https://api.gmgn.ai/v2';

async function fetchTokenData(tokenAddress) {
  try {
    const res = await fetch(`${BASE}/tokens/sol/${tokenAddress}`, { signal: AbortSignal.timeout(6000) });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const t = data?.data?.token;
    if (!t) return null;
    return {
      priceUsd: parseFloat(t.price_usd) || 0,
      fdv: t.fdv || 0,
      liquidityUsd: t.liquidity || 0,
      vol5m: 0, vol1h: t.volume_1h || 0, vol24h: t.volume_24h || 0,
      buys5m: 0, sells5m: 0, txns5m: 0,
      buys1h: t.swaps_1h?.buys || 0, sells1h: t.swaps_1h?.sells || 0,
      priceChange5m: t.price_change_5m || 0, priceChange1h: t.price_change_1h || 0,
      symbol: t.symbol || null, name: t.name || null,
      pairCreatedAt: null, dexId: 'gmgn',
      source: 'gmgn',
      holderCount: t.holder_count || 0,
      creator: t.creator_address || null
    };
  } catch { return null; }
}

async function fetchNewTokens() {
  try {
    const res = await fetch(`${BASE}/tokens/sol/new?limit=50`, { signal: AbortSignal.timeout(8000) });
    if (!res || !res.ok) return [];
    const data = await res.json();
    return (data?.data || []).map(t => ({
      tokenAddress: t.address,
      symbol: t.symbol,
      name: t.name,
      creator: t.creator_address || null,
      fdv: t.fdv || 0,
      volume24h: t.volume_24h || 0,
      liquidity: t.liquidity || 0,
      holderCount: t.holder_count || 0
    }));
  } catch { return []; }
}

async function fetchTokenPrice(tokenAddress) {
  try {
    const d = await fetchTokenData(tokenAddress);
    return d ? d.priceUsd : null;
  } catch { return null; }
}

module.exports = { fetchTokenData, fetchNewTokens, fetchTokenPrice, name: 'gmgn' };
