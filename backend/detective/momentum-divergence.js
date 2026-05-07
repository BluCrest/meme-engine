const db = require('../database/db');
const config = require('../config');
const { getCurrentPrice, getPriceAt, getTokenSymbol } = require('../utils/price-feed');

// How many minutes to look back for divergence check
const DIVERGENCE_WINDOW_MINUTES = 10;

// getCurrentPrice is now imported from utils/price-feed.js

// getPriceAt is now imported from utils/price-feed.js

const { getTopHolders: fetchHolders, getHolderBalanceAt: fetchBalanceAt } = require('../utils/holders');

async function getTopHolders(tokenAddress, limit = 20) {
  return fetchHolders(tokenAddress, limit);
}

async function getHolderBalanceAt(holderAddress, tokenAddress, timestamp) {
  return fetchBalanceAt(holderAddress, tokenAddress, timestamp);
}

async function checkMomentumDivergence(tokenAddress) {
  try {
    const now = Date.now();
    const windowStart = now - DIVERGENCE_WINDOW_MINUTES * 60 * 1000;

    // Get price change over window
    const priceNow = await getCurrentPrice(tokenAddress);
    const priceThen = await getPriceAt(tokenAddress, windowStart);

    const priceChangePct = priceThen > 0
      ? ((priceNow - priceThen) / priceThen) * 100
      : 0;

    // Get top 20 holder balance changes
    const topHolders = await getTopHolders(tokenAddress, 20);
    let sellersCount = 0;
    let totalSellPct = 0;

    for (const holder of topHolders) {
      const balanceNow = holder.balance || 0;
      const balanceThen = await getHolderBalanceAt(holder.address, tokenAddress, windowStart);

      if (balanceThen > 0) {
        const changePct = ((balanceNow - balanceThen) / balanceThen) * 100;
        if (changePct < -10) { // Reduced by >10% = selling
          sellersCount++;
          totalSellPct += Math.abs(changePct);
        }
      }
    }

    const walletSellPct = topHolders.length > 0
      ? (sellersCount / topHolders.length) * 100
      : 0;

    // Divergence = price up + holders dumping = red flag
    let divergenceScore = 0;
    if (priceChangePct > 10 && walletSellPct > 40) {
      divergenceScore = Math.min(100, (priceChangePct * 0.3) + (walletSellPct * 0.7));
    }

    const result = {
      priceChangePct,
      walletSellPct,
      sellersCount,
      divergenceScore,
      isDivergent: divergenceScore > 50,
      windowMinutes: DIVERGENCE_WINDOW_MINUTES
    };

    // Log if divergence detected
    if (divergenceScore > 50) {
      await db.insertDivergenceSignal({
        token_address: tokenAddress,
        detected_at: new Date(),
        price_change_pct: priceChangePct,
        wallet_sell_pct: walletSellPct,
        divergence_score: divergenceScore,
        action_taken: 'alert_sent'
      });

      const symbol = await getTokenSymbol(tokenAddress);
      const { bot } = require('../operator/telegram-bot');
      await bot.sendMessage(
        config.telegram.chatId,
        `📉 *DIVERGENCE ALERT* — $${symbol}\n` +
        `Price: +${priceChangePct.toFixed(1)}% BUT ${sellersCount}/20 top wallets are selling\n` +
        `Divergence Score: ${divergenceScore.toFixed(0)}/100`,
        { parse_mode: 'Markdown' }
      );
    }

    return result;

  } catch (err) {
    console.error('[Divergence] Error:', err.message);
    return {
      priceChangePct: 0,
      walletSellPct: 0,
      sellersCount: 0,
      divergenceScore: 0,
      isDivergent: false,
      error: err.message
    };
  }
}

// getTokenSymbol is now imported from utils/price-feed.js

// Run this on all open positions every 2 minutes
async function runDivergenceScan() {
  const positions = await db.getOpenPositions();
  console.log(`[Divergence] Scanning ${positions.length} open positions...`);

  for (const position of positions) {
    const result = await checkMomentumDivergence(position.token_address);

    // If holding and divergent, suggest taking profits
    if (result.isDivergent && position.remaining_ratio > 0) {
      const { bot } = require('../operator/telegram-bot');
      await bot.sendMessage(
        config.telegram.chatId,
        `⚠️ *DIVERGENCE + PROFIT* — Consider taking profits on position`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

module.exports = { checkMomentumDivergence, runDivergenceScan };