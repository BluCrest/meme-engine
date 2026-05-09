const dexScreener = require('./dex-screener');
const gmgn = require('./gmgn');
const pumpFun = require('./pump-fun');
const { rateLimitedFetch } = require('../utils/dex-rate-limit');

const SOURCES = [dexScreener, gmgn, pumpFun];
let sourceIndex = 0;

function rotate() {
  sourceIndex = (sourceIndex + 1) % SOURCES.length;
}

function getCurrent() {
  return SOURCES[sourceIndex];
}

async function fetchTokenData(tokenAddress) {
  const startIdx = sourceIndex;
  for (let i = 0; i < SOURCES.length; i++) {
    const src = SOURCES[(startIdx + i) % SOURCES.length];
    try {
      const result = await src.fetchTokenData(tokenAddress);
      if (result) {
        if (i > 0) rotate();
        return result;
      }
    } catch {}
  }
  return null;
}

async function fetchTokenPrice(tokenAddress) {
  const d = await fetchTokenData(tokenAddress);
  return d ? d.priceUsd : null;
}

async function fetchDexVolume(tokenAddress) {
  const data = await fetchTokenData(tokenAddress);
  if (!data) return null;
  return {
    vol5m: data.vol5m || 0, vol1h: data.vol1h || 0,
    buys5m: data.buys5m || 0, sells5m: data.sells5m || 0,
    txns5m: data.txns5m || 0,
    symbol: data.symbol || null, baseToken: data.name || null,
    source: data.source
  };
}

async function fetchAllNewTokens() {
  const all = [];
  const seen = new Set();
  // Pump.fun first — real new launches with addresses
  const pumpTokens = await pumpFun.fetchNewTokens().catch(() => []);
  for (const t of pumpTokens) {
    const addr = t.tokenAddress;
    if (addr && !seen.has(addr)) { seen.add(addr); all.push(t); }
  }
  // DexScreener profiles — supplements with graduated tokens
  const dexProfiles = await dexScreener.fetchNewProfiles().catch(() => []);
  for (const t of dexProfiles) {
    const addr = t.tokenAddress;
    if (addr && !seen.has(addr)) { seen.add(addr); all.push(t); }
  }
  // GMGN (may 403 on Render, but try anyway)
  const gmgnTokens = await gmgn.fetchNewTokens().catch(() => []);
  for (const t of gmgnTokens) {
    const addr = t.tokenAddress || t.address;
    if (addr && !seen.has(addr)) { seen.add(addr); all.push(t); }
  }
  return all;
}

// Convert unified token data to DexScreener-compatible pair format
function toDexScreenerPair(data) {
  if (!data) return null;
  return {
    priceUsd: String(data.priceUsd || 0),
    fdv: data.fdv || 0,
    liquidity: { usd: data.liquidityUsd || 0 },
    volume: { m5: data.vol5m || 0, h1: data.vol1h || 0, h24: data.vol24h || 0 },
    txns: {
      m5: { buys: data.buys5m || 0, sells: data.sells5m || 0 },
      h1: { buys: data.buys1h || 0, sells: data.sells1h || 0 },
      h24: { buys: 0, sells: 0 }
    },
    priceChange: { m5: data.priceChange5m || 0, h1: data.priceChange1h || 0, h24: 0 },
    baseToken: { symbol: data.symbol || null, name: data.name || null },
    pairCreatedAt: data.pairCreatedAt || null,
    dexId: data.dexId || null,
    source: data.source || 'unknown'
  };
}

async function fetchPair(tokenAddress) {
  // Try multi-source first
  const data = await fetchTokenData(tokenAddress);
  if (data) return toDexScreenerPair(data);
  // Fallback: direct DexScreener call as last resort
  try {
    const res = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    if (res && res.ok) {
      const json = await res.json();
      return json.pairs?.[0] || null;
    }
  } catch {}
  return null;
}

async function fetchPrice(tokenAddress) {
  const p = await fetchPair(tokenAddress);
  return p ? parseFloat(p.priceUsd) || 0 : 0;
}

async function fetchMC(tokenAddress) {
  const p = await fetchPair(tokenAddress);
  return p ? p.fdv || 0 : 0;
}

async function fetchSymbol(tokenAddress) {
  const p = await fetchPair(tokenAddress);
  return p?.baseToken?.symbol || 'UNKNOWN';
}

async function fetchName(tokenAddress) {
  const p = await fetchPair(tokenAddress);
  return p?.baseToken?.name || 'Unknown';
}

module.exports = {
  fetchTokenData, fetchTokenPrice, fetchDexVolume,
  fetchAllNewTokens,
  fetchPair, fetchPrice, fetchMC, fetchSymbol, fetchName,
  rotate, getCurrent, sources: SOURCES
};
