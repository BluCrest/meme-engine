const DEXPAPRIKA_BASE = 'https://api.dexpaprika.com';
const GMGN_RANK_URL = 'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/24h';

async function fetchDexPaprikaVolume(tokenAddress) {
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
      volume_24h: s['24h']?.volume_usd || 0,
      volume_6h: s['6h']?.volume_usd || 0,
      volume_1h: s['1h']?.volume_usd || 0,
      volume_5m: s['5m']?.volume_usd || 0,
      buys_24h: s['24h']?.buys || 0,
      sells_24h: s['24h']?.sells || 0,
      txns_24h: s['24h']?.txns || 0,
      liquidity_usd: s.liquidity_usd || 0,
      source: 'dexpaprika'
    };
  } catch (e) {
    return null;
  }
}

async function fetchGMGNTokenVolume(tokenAddress) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${GMGN_RANK_URL}?orderby=volume&direction=desc&limit=50`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const tokens = data?.data || [];
    const match = tokens.find(t => t.address === tokenAddress);
    if (!match) return null;
    return {
      volume_24h: match.volume || 0,
      swaps_24h: match.swaps || 0,
      buys_24h: match.buys || 0,
      sells_24h: match.sells || 0,
      liquidity_usd: match.liquidity || 0,
      holder_count: match.holder_count || 0,
      source: 'gmgn'
    };
  } catch (e) {
    return null;
  }
}

async function getMultiSourceVolume(tokenAddress, dexscreenerVolume) {
  const results = [];

  if (dexscreenerVolume > 0) {
    results.push({
      volume_24h: dexscreenerVolume,
      source: 'dexscreener'
    });
  }

  const [dexPaprika, gmgn] = await Promise.all([
    fetchDexPaprikaVolume(tokenAddress),
    fetchGMGNTokenVolume(tokenAddress)
  ]);

  if (dexPaprika) results.push(dexPaprika);
  if (gmgn) results.push(gmgn);

  if (!results.length) {
    return {
      volume_24h: 0,
      volume_sources: 0,
      avg_volume_24h: 0,
      max_volume_24h: 0,
      sources: []
    };
  }

  const volumes = results.map(r => r.volume_24h || 0);
  return {
    volume_24h: Math.max(...volumes),
    volume_sources: results.length,
    avg_volume_24h: volumes.reduce((a, b) => a + b, 0) / volumes.length,
    max_volume_24h: Math.max(...volumes),
    sources: results
  };
}

module.exports = { getMultiSourceVolume, fetchDexPaprikaVolume, fetchGMGNTokenVolume };
