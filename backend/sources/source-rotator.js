const dexScreener = require('./dex-screener');
const gmgn = require('./gmgn');
const pumpFun = require('./pump-fun');

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
  for (const src of SOURCES) {
    try {
      let tokens;
      if (src.fetchNewProfiles) tokens = await src.fetchNewProfiles();
      else if (src.fetchNewTokens) tokens = await src.fetchNewTokens();
      else continue;
      for (const t of (tokens || [])) {
        const addr = t.tokenAddress || t.address;
        if (addr && !seen.has(addr)) {
          seen.add(addr);
          all.push(t);
        }
      }
    } catch {}
  }
  return all;
}

async function fetchSearchPairs() {
  try {
    return await dexScreener.fetchSearchPairs();
  } catch { return []; }
}

module.exports = {
  fetchTokenData, fetchTokenPrice, fetchDexVolume,
  fetchAllNewTokens, fetchSearchPairs,
  rotate, getCurrent, sources: SOURCES
};
