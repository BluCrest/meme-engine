const db = require('../database/db');

/**
 * Get current token price from DexScreener
 * Returns price in USD
 */
async function getCurrentPrice(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();

    const pair = data.pairs?.[0];
    if (!pair) return 0;

    // Store price snapshot for historical tracking
    await db.getDb().collection('price_snapshots').insertOne({
      token_address: tokenAddress,
      price: parseFloat(pair.priceUsd) || 0,
      market_cap: parseFloat(pair.fdv) || 0,
      liquidity: parseFloat(pair.liquidity?.usd) || 0,
      volume_24h: parseFloat(pair.volume?.h24) || 0,
      timestamp: new Date()
    });

    return parseFloat(pair.priceUsd) || 0;
  } catch (err) {
    console.error('[PriceFeed] Error:', err.message);
    return 0;
  }
}

/**
 * Get current market cap from DexScreener
 */
async function getCurrentMC(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    const pair = data.pairs?.[0];
    return pair ? parseFloat(pair.fdv) || 0 : 0;
  } catch (err) {
    console.error('[PriceFeed] MC Error:', err.message);
    return 0;
  }
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
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    return data.pairs?.[0]?.baseToken?.symbol || 'UNKNOWN';
  } catch (err) {
    return 'UNKNOWN';
  }
}

/**
 * Get token name from DexScreener
 */
async function getTokenName(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    return data.pairs?.[0]?.baseToken?.name || 'Unknown';
  } catch (err) {
    return 'Unknown';
  }
}

module.exports = {
  getCurrentPrice,
  getCurrentMC,
  getPriceAt,
  getTokenSymbol,
  getTokenName
};