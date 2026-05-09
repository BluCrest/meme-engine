const db = require('../database/db');
const { fetchPair, fetchPrice, fetchMC, fetchSymbol, fetchName } = require('../sources/source-rotator');

const priceCache = new Map();
const CACHE_TTL = 120000; // 2 min cache

async function getCurrentPrice(tokenAddress) {
  const cached = priceCache.get(tokenAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.price;

  try {
    const pair = await fetchPair(tokenAddress);
    if (!pair) return 0;
    const price = parseFloat(pair.priceUsd) || 0;

    // Store price snapshot for historical tracking
    await db.getDb().collection('price_snapshots').insertOne({
      token_address: tokenAddress,
      price,
      market_cap: pair.fdv || 0,
      liquidity: pair.liquidity?.usd || 0,
      volume_24h: pair.volume?.h24 || 0,
      timestamp: new Date()
    });

    priceCache.set(tokenAddress, { price, ts: Date.now() });
    return price;
  } catch (err) {
    console.error('[PriceFeed] Error:', err.message);
    return 0;
  }
}

/**
 * Get current market cap from DexScreener
 */
async function getCurrentMC(tokenAddress) {
  return fetchMC(tokenAddress);
}

/**
 * Get price at a specific timestamp (from our snapshots)
 */
async function getPriceAt(tokenAddress, timestamp) {
  try {
    const snapshot = await db.getDb().collection('price_snapshots')
      .findOne(
        {
          token_address: tokenAddress,
          timestamp: { $lte: new Date(timestamp) }
        },
        { sort: { timestamp: -1 } }
      );
    return snapshot?.price || 0;
  } catch (err) {
    console.error('[PriceFeed] Historical price error:', err.message);
    return 0;
  }
}

/**
 * Get token symbol from DexScreener
 */
async function getTokenSymbol(tokenAddress) {
  return fetchSymbol(tokenAddress);
}

async function getTokenName(tokenAddress) {
  return fetchName(tokenAddress);
}

async function getTokenProfile(tokenAddress) {
  try {
    const pair = await fetchPair(tokenAddress);
    if (!pair) return null;
    return {
      price: parseFloat(pair.priceUsd) || 0,
      marketCap: pair.fdv || 0,
      liquidity: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      volume1h: pair.volume?.h1 || 0,
      volume5m: pair.volume?.m5 || 0,
      txns24h: { buys: pair.txns?.h24?.buys || 0, sells: pair.txns?.h24?.sells || 0 },
      txns1h: { buys: pair.txns?.h1?.buys || 0, sells: pair.txns?.h1?.sells || 0 },
      txns5m: { buys: pair.txns?.m5?.buys || 0, sells: pair.txns?.m5?.sells || 0 },
      priceChange24h: pair.priceChange?.h24 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      priceChange5m: pair.priceChange?.m5 || 0,
      age: pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null,
      ageMinutes: pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 60000) : null,
      dex: pair.dexId,
      symbol: pair.baseToken?.symbol,
      name: pair.baseToken?.name
    };
  } catch (err) {
    console.error('[PriceFeed] Profile error:', err.message);
    return null;
  }
}

module.exports = {
  getCurrentPrice,
  getCurrentMC,
  getPriceAt,
  getTokenSymbol,
  getTokenName,
  getTokenProfile
};