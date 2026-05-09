const API_BASE = 'https://frontend-api-v3.pump.fun';

async function fetchTokenData(tokenAddress) {
  try {
    const res = await fetch(`${API_BASE}/coins/${tokenAddress}`, { signal: AbortSignal.timeout(6000) });
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (!data) return null;
    const vir = data.virtualTokenReserves || 0;
    const vs = data.virtualSolReserves || 0;
    const price = vs > 0 && vir > 0 ? vs / vir * 1e9 : 0;
    const totalSupply = data.totalSupply || 0;
    return {
      priceUsd: price * 0, // Pump.fun price is in SOL, convert roughly
      fdv: data.fdv || 0,
      liquidityUsd: data.liquidity || 0,
      vol5m: data.volume_5m || 0, vol1h: data.volume_1h || 0, vol24h: data.volume_24h || 0,
      buys5m: data.txns_5m?.buys || 0, sells5m: data.txns_5m?.sells || 0,
      txns5m: (data.txns_5m?.buys || 0) + (data.txns_5m?.sells || 0),
      buys1h: data.txns_1h?.buys || 0, sells1h: data.txns_1h?.sells || 0,
      priceChange5m: data.price_change_5m || 0, priceChange1h: data.price_change_1h || 0,
      symbol: data.symbol || null, name: data.name || null,
      pairCreatedAt: data.created_at || null,
      dexId: 'pumpfun',
      source: 'pumpfun',
      creator: data.creator_address || null,
      totalSupply,
      reserveRatio: vir > 0 ? vs / vir : 0
    };
  } catch { return null; }
}

async function fetchNewTokens() {
  try {
    const res = await fetch(`${API_BASE}/coins?offset=0&limit=50&sort=created`, { signal: AbortSignal.timeout(8000) });
    if (!res || !res.ok) return [];
    const data = await res.json();
    return (data || []).map(c => ({
      tokenAddress: c.mint,
      symbol: c.symbol,
      name: c.name,
      creator: c.creator_address || null,
      fdv: c.fdv || 0,
      volume24h: c.volume_24h || 0,
      liquidity: c.liquidity || 0
    }));
  } catch { return []; }
}

async function fetchTokenPrice(tokenAddress) {
  try {
    const d = await fetchTokenData(tokenAddress);
    return d ? d.priceUsd : null;
  } catch { return null; }
}

module.exports = { fetchTokenData, fetchNewTokens, fetchTokenPrice, name: 'pumpfun' };
