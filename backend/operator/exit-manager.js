const db = require('../database/db');
const { executeSell } = require('./trade-executor');
const { sendPnLCard, generatePnLCard } = require('./pnl-card');
const { checkMomentumDivergence } = require('../detective/momentum-divergence');
const config = require('../config');

const EXIT_RULES = [
  { pnlThreshold: 0.5,  sellRatio: 0.25, label: '1.5x tier: sell 25%' },
  { pnlThreshold: 1.0,  sellRatio: 0.25, label: '2x tier: sell another 25%' },
  { pnlThreshold: 2.0,  sellRatio: 0.20, label: '3x tier: sell 20%' },
  { pnlThreshold: 4.0,  sellRatio: 0.15, label: '5x tier: sell 15%' },
];

async function getCurrentPrice(tokenAddress) {
  const pf = require('../utils/price-feed');
  return pf.getCurrentPrice(tokenAddress);
}

async function getDevWallet(tokenAddress) {
  const token = await db.getToken(tokenAddress);
  return token?.dev_wallet;
}

async function rugSpeedPredictor(position, devWallet) {
  if (!devWallet) return null;

  const devProfile = await db.getDevProfile(devWallet);
  if (!devProfile || devProfile.label !== 'serial_rugger') return null;
  if (!devProfile.avg_time_to_rug_hours) return null;

  const hoursHeld = (Date.now() - new Date(position.opened_at).getTime()) / 3600000;
  const rugDeadline = devProfile.avg_time_to_rug_hours * 0.85; // sell at 85% of avg rug time

  if (hoursHeld >= rugDeadline) {
    return {
      triggered: true,
      reason: 'rug_speed_predictor',
      message: `⏱️ *RUG TIMER* — Sold before avg rug window (${devProfile.avg_time_to_rug_hours.toFixed(1)}h)`
    };
  }

  return null;
}

async function checkExitRules(position, currentPrice) {
  const entryPrice = position.entry_price || 1;
  const pnl = entryPrice > 0 ? (currentPrice / entryPrice) - 1 : 0;

  for (const rule of EXIT_RULES) {
    if (pnl >= rule.pnlThreshold && !position[`sold_${rule.pnlThreshold}`]) {
      return {
        triggered: true,
        rule,
        pnl,
        message: `🎯 *${rule.label}* — PnL: +${(pnl * 100).toFixed(0)}%`
      };
    }
  }

  return null;
}

async function trailingStopCheck(position, currentPrice) {
  const entryPrice = position.entry_price || 1;
  const pnl = (currentPrice / entryPrice) - 1;

  if (pnl < 2.0) return null; // Only trail after 3x

  const peakPrice = position.highest_price || currentPrice;
  const drawdownFromPeak = (peakPrice - currentPrice) / peakPrice;

  if (drawdownFromPeak >= 0.25) {
    return {
      triggered: true,
      reason: 'trailing_stop',
      message: `🛑 *TRAILING STOP HIT* — Drawdown: ${(drawdownFromPeak * 100).toFixed(0)}% from peak`
    };
  }

  return null;
}

async function momentumDivergenceExit(tokenAddress, position, currentPrice) {
  const divergence = await checkMomentumDivergence(tokenAddress);
  if (!divergence.isDivergent) return null;

  const entryPrice = position.entry_price || 1;
  const pnl = (currentPrice / entryPrice) - 1;

  if (pnl > 0) {
    return {
      triggered: true,
      reason: 'divergence_exit',
      message: `📉 *DIVERGENCE EXIT* — Price up + wallets dumping (Score: ${divergence.divergenceScore.toFixed(0)})`
    };
  }

  return null;
}

async function processExitsForPosition(position) {
  const chatId = config.telegram.chatId;

  try {
    const currentPrice = await getCurrentPrice(position.token_address);
    if (!currentPrice) return;

    // Update highest price
    if (currentPrice > (position.highest_price || 0)) {
      await db.updateHighestPrice(position._id, currentPrice);
    }

    // 0. Sell target from auto-buy — partial take-profit, let runners ride
    if (position.sell_target_multiplier && position.entry_price > 0) {
      const targetPrice = position.entry_price * position.sell_target_multiplier;
      if (currentPrice >= targetPrice && !position.sell_target_taken) {
        // Moonshots sell less (20%), normal sell 33% — keep riding
        const isMoonshot = (position.moonshot_probability || 0) > 50;
        const sellRatio = isMoonshot ? 0.2 : 0.33;
        await executeSell(position.token_address, sellRatio, 'sell_target_partial');
        await db.getDb().collection('positions').updateOne(
          { _id: position._id },
          { $set: { sell_target_taken: true } }
        );
        const label = isMoonshot ? '🌙 Moonshot' : '🎯 Take-profit';
        await sendTelegramMessage(chatId, `${label} — Sold ${(sellRatio * 100).toFixed(0)}% at ${position.sell_target_multiplier.toFixed(2)}x, rest riding`);
        // Don't return — let other exit rules handle the rest
      }
    }

    // 1. Rug Speed Predictor (highest priority)
    const devWallet = await getDevWallet(position.token_address);
    const rugCheck = await rugSpeedPredictor(position, devWallet);
    if (rugCheck) {
      await executeSell(position.token_address, 1.0, rugCheck.reason);
      await sendTelegramMessage(chatId, rugCheck.message);
      return;
    }

    // 2. Momentum Divergence Exit
    const divergenceExit = await momentumDivergenceExit(position.token_address, position, currentPrice);
    if (divergenceExit) {
      await executeSell(position.token_address, 0.5, divergenceExit.reason);
      await sendTelegramMessage(chatId, divergenceExit.message);
    }

    // 3. Exit Rules (scaling sells)
    const exitRule = await checkExitRules(position, currentPrice);
    if (exitRule) {
      await executeSell(position.token_address, exitRule.rule.sellRatio, `exit_rule_${exitRule.rule.pnlThreshold}`);
      await db.markExitTierHit(position._id, exitRule.rule.pnlThreshold);

      const card = await generatePnLCard({
        ...position,
        exit_mc: currentPrice,
        mc_at_trade: currentPrice
      });
      await sendTelegramMessage(chatId, `${exitRule.message}\n\n${card}`);
      return;
    }

    // 4. Trailing Stop
    const trailing = await trailingStopCheck(position, currentPrice);
    if (trailing) {
      await executeSell(position.token_address, 1.0, trailing.reason);
      await sendTelegramMessage(chatId, trailing.message);
    }

  } catch (err) {
    console.error(`[ExitMgr] Error processing ${position.token_address}:`, err.message);
  }
}

async function sendTelegramMessage(chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (_) {}
}

async function runExitManager() {
  const openPositions = await db.getOpenPositions();
  console.log(`[ExitMgr] Checking ${openPositions.length} open positions...`);

  for (const position of openPositions) {
    await processExitsForPosition(position);
  }
}

// Start exit manager loop
let exitInterval;
function startExitManager() {
  const interval = (config.config.divergenceCheckInterval || 120) * 1000;
  exitInterval = setInterval(runExitManager, interval);
  console.log(`[ExitMgr] Started, checking every ${interval / 1000}s`);
}

function stopExitManager() {
  if (exitInterval) clearInterval(exitInterval);
}

module.exports = {
  runExitManager,
  startExitManager,
  stopExitManager,
  processExitsForPosition,
  rugSpeedPredictor,
  checkExitRules,
  trailingStopCheck
};