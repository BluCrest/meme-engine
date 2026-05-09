const db = require('../database/db');
const { executeSell } = require('./trade-executor');
const { sendPnLCard, generatePnLCard } = require('./pnl-card');
const { checkMomentumDivergence } = require('../detective/momentum-divergence');
const { areSmartWalletsDumping, checkSmartWalletBalances } = require('../sentinel/wallet-dump-monitor');
const { checkTokenSellPressure } = require('../sentinel/sell-pressure-monitor');
const { getXSentiment } = require('../detective/x-scanner');
const config = require('../config');

const EXIT_RULES = [
  { pnlThreshold: 0.5, sellRatio: 0.25, label: '1.5x tier: sell 25%' },
  { pnlThreshold: 1.0, sellRatio: 0.25, label: '2x tier: sell another 25%' },
  { pnlThreshold: 2.0, sellRatio: 0.20, label: '3x tier: sell 20%' },
  { pnlThreshold: 4.0, sellRatio: 0.15, label: '5x tier: sell 15%' },
];
const STOP_LOSS_PCT = -0.35;
const LOW_BALANCE_ALERT = 0.02;
const STOP_LOSS_COOLDOWN_MIN = 10;
const MAX_DAILY_LOSS_SOL = 0.05;
const CONSECUTIVE_LOSS_LIMIT = 3;

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
  const rugDeadline = devProfile.avg_time_to_rug_hours * 0.85;
  if (hoursHeld >= rugDeadline) {
    return { triggered: true, reason: 'rug_speed_predictor', message: `⏱️ *RUG TIMER* — Sold before avg rug window (${devProfile.avg_time_to_rug_hours.toFixed(1)}h)` };
  }
  return null;
}

async function checkExitRules(position, currentPrice) {
  const entryPrice = position.entry_price || 1;
  const pnl = entryPrice > 0 ? (currentPrice / entryPrice) - 1 : 0;
  for (const rule of EXIT_RULES) {
    if (pnl >= rule.pnlThreshold && !position[`sold_${rule.pnlThreshold}`]) {
      return { triggered: true, rule, pnl, message: `🎯 *${rule.label}* — PnL: +${(pnl * 100).toFixed(0)}%` };
    }
  }
  return null;
}

async function trailingStopCheck(position, currentPrice) {
  const entryPrice = position.entry_price || 1;
  const pnl = (currentPrice / entryPrice) - 1;
  if (pnl < 2.0) return null;
  const peakPrice = position.highest_price || currentPrice;
  const drawdownFromPeak = (peakPrice - currentPrice) / peakPrice;
  if (drawdownFromPeak >= 0.25) {
    return { triggered: true, reason: 'trailing_stop', message: `🛑 *TRAILING STOP HIT* — Drawdown: ${(drawdownFromPeak * 100).toFixed(0)}% from peak` };
  }
  return null;
}

async function momentumDivergenceExit(tokenAddress, position, currentPrice) {
  const divergence = await checkMomentumDivergence(tokenAddress);
  if (!divergence.isDivergent) return null;
  const entryPrice = position.entry_price || 1;
  const pnl = (currentPrice / entryPrice) - 1;
  if (pnl > 0) {
    return { triggered: true, reason: 'divergence_exit', message: `📉 *DIVERGENCE EXIT* — Price up + wallets dumping (Score: ${divergence.divergenceScore.toFixed(0)})` };
  }
  return null;
}

async function stopLossCheck(position, currentPrice) {
  const entryPrice = position.entry_price || 1;
  const pnl = (currentPrice / entryPrice) - 1;
  if (pnl <= STOP_LOSS_PCT) {
    return { triggered: true, reason: 'stop_loss', pnl, message: `🛑 *STOP-LOSS HIT* — PnL: ${(pnl * 100).toFixed(0)}% at ${currentPrice.toFixed(6)}` };
  }
  return null;
}

async function processExitsForPosition(position) {
  const chatId = config.telegram.chatId;
  try {
    // Paper trading: skip all stop-loss / exit rules
    if (await db.getPaperTrading()) return;

    const currentPrice = await getCurrentPrice(position.token_address);
    if (!currentPrice) return;

    if (currentPrice > (position.highest_price || 0)) {
      await db.updateHighestPrice(position._id, currentPrice);
    }

    // 0. Stop-loss (highest priority — protect capital)
    const sl = await stopLossCheck(position, currentPrice);
    if (sl) {
      await executeSell(position.token_address, 1.0, sl.reason);
      await sendTelegramMessage(chatId, sl.message);
      await recordStopLoss(position, sl.pnl);
      return;
    }

    // 1. Rug Speed Predictor
    const devWallet = await getDevWallet(position.token_address);
    const rugCheck = await rugSpeedPredictor(position, devWallet);
    if (rugCheck) {
      await executeSell(position.token_address, 1.0, rugCheck.reason);
      await sendTelegramMessage(chatId, rugCheck.message);
      return;
    }

    // 2. Sell target from auto-buy — partial take-profit
    if (position.sell_target_multiplier && position.entry_price > 0) {
      const targetPrice = position.entry_price * position.sell_target_multiplier;
      if (currentPrice >= targetPrice && !position.sell_target_taken) {
        const isMoonshot = (position.moonshot_probability || 0) > 50;
        const sellRatio = isMoonshot ? 0.2 : 0.33;
        await executeSell(position.token_address, sellRatio, 'sell_target_partial');
        await db.getDb().collection('positions').updateOne(
          { _id: position._id },
          { $set: { sell_target_taken: true } }
        );
        const label = isMoonshot ? '🌙 Moonshot' : '🎯 Take-profit';
        await sendTelegramMessage(chatId, `${label} — Sold ${(sellRatio * 100).toFixed(0)}% at ${position.sell_target_multiplier.toFixed(2)}x, rest riding`);
      }
    }

    // 3. Onchain sell pressure (DexScreener + DexPaprika buy/sell ratios)
    const pressureSignals = await checkTokenSellPressure(position.token_address);
    if (pressureSignals) {
      const critical = pressureSignals.find(s => s.severity === 'critical');
      if (critical) {
        await executeSell(position.token_address, 1.0, critical.reason);
        await sendTelegramMessage(chatId, critical.message);
        return;
      }
      const high = pressureSignals.find(s => s.severity === 'high');
      if (high) {
        await executeSell(position.token_address, 0.5, high.reason);
        await sendTelegramMessage(chatId, high.message);
      }
      const medium = pressureSignals.find(s => s.severity === 'medium' && s.triggered);
      if (medium && !high && !critical) {
        await sendTelegramMessage(chatId, medium.message + ' — monitoring');
      }
    }

    // 4. Wallet dump detection (smart wallets selling the same token)
    const walletDump = await areSmartWalletsDumping(position.token_address, position.symbol);
    if (walletDump && walletDump.triggered) {
      await executeSell(position.token_address, 1.0, walletDump.reason);
      await sendTelegramMessage(chatId, walletDump.message);
      return;
    }
    const balanceDrop = await checkSmartWalletBalances(position.token_address);
    if (balanceDrop && balanceDrop.triggered) {
      await executeSell(position.token_address, 1.0, balanceDrop.reason);
      await sendTelegramMessage(chatId, balanceDrop.message);
      return;
    }

    // 5. X social sentiment check for held tokens
    if (position.symbol) {
      try {
        const sentiment = await getXSentiment(`$${position.symbol}`, 30);
        if (sentiment.volume >= 5 && sentiment.score < 30) {
          await sendTelegramMessage(chatId, `🐻 *BEARISH SENTIMENT* on $${position.symbol} (X score: ${sentiment.score}/100) — watching`);
        }
      } catch (_) {}
    }

    // 6. Momentum Divergence Exit
    const divergenceExit = await momentumDivergenceExit(position.token_address, position, currentPrice);
    if (divergenceExit) {
      await executeSell(position.token_address, 0.5, divergenceExit.reason);
      await sendTelegramMessage(chatId, divergenceExit.message);
    }

    // 7. Exit Rules (scaling sells)
    const exitRule = await checkExitRules(position, currentPrice);
    if (exitRule) {
      await executeSell(position.token_address, exitRule.rule.sellRatio, `exit_rule_${exitRule.rule.pnlThreshold}`);
      await db.markExitTierHit(position._id, exitRule.rule.pnlThreshold);
      await sendTelegramMessage(chatId, `${exitRule.message}`);
      return;
    }

    // 8. Trailing Stop
    const trailing = await trailingStopCheck(position, currentPrice);
    if (trailing) {
      await executeSell(position.token_address, 1.0, trailing.reason);
      await sendTelegramMessage(chatId, trailing.message);
    }

  } catch (err) {
    console.error(`[ExitMgr] Error processing ${position.token_address}:`, err.message);
  }
}

async function recordStopLoss(position, pnl) {
  const token = await db.getToken(position.token_address);
  await db.getDb().collection('stop_losses').insertOne({
    token_address: position.token_address,
    symbol: token?.symbol || '',
    pnl_pct: pnl * 100,
    entry_price: position.entry_price,
    sol_invested: position.sol_invested || 0,
    stopped_at: new Date(),
    cooldown_until: new Date(Date.now() + STOP_LOSS_COOLDOWN_MIN * 60 * 1000)
  });
  // Record outcome for pattern memory learning
  try {
    const patternMemory = require('../agents/pattern-memory');
    await patternMemory.recordTradeOutcome(position.token_address, pnl * 100, null);
    const adaptiveWeights = require('../agents/adaptive-weights');
    const tokenRec = await db.getToken(position.token_address);
    await adaptiveWeights.recordResult(position.token_address, tokenRec?.ape_probability || 0, pnl * 100);
  } catch (_) {}
}

async function checkCircuitBreakers() {
  const results = { stopTrading: false, reason: '' };

  // Daily drawdown: sum all stop-losses today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayLosses = await db.getDb().collection('stop_losses').find({
    stopped_at: { $gte: today }
  }).toArray();
  const totalLostToday = todayLosses.reduce((s, l) => s + (l.sol_invested || 0), 0);
  if (totalLostToday >= MAX_DAILY_LOSS_SOL) {
    results.stopTrading = true;
    results.reason = `Daily loss limit hit: ${totalLostToday.toFixed(3)} SOL (max ${MAX_DAILY_LOSS_SOL})`;
    return results;
  }

  // Consecutive losses — auto-resets after 30 minutes without a new stop-loss
  const recentLosses = await db.getDb().collection('stop_losses').find()
    .sort({ stopped_at: -1 }).limit(CONSECUTIVE_LOSS_LIMIT).toArray();
  if (recentLosses.length >= CONSECUTIVE_LOSS_LIMIT) {
    const allRecent = recentLosses.every(l => l.pnl_pct < -20);
    const newest = recentLosses[0];
    const newestAge = newest ? (Date.now() - new Date(newest.stopped_at).getTime()) / 60000 : 0;
    if (allRecent && newestAge < 30) {
      results.stopTrading = true;
      results.reason = `${CONSECUTIVE_LOSS_LIMIT} consecutive losses — new buys paused (auto-resets in ${(30 - newestAge).toFixed(0)}m)`;
      return results;
    }
  }

  return results;
}

async function checkLowBalance() {
  const { getBalance } = require('./trade-executor');
  const bal = await getBalance();
  if (bal < LOW_BALANCE_ALERT && bal > 0) {
    const chatId = config.telegram.chatId;
    await sendTelegramMessage(chatId, `⚠️ *LOW WALLET BALANCE*\n\n${bal.toFixed(4)} SOL remaining.\nDeposit more SOL to continue trading.`);
  }
  return bal;
}

async function isTokenInCooldown(tokenAddress) {
  const recent = await db.getDb().collection('stop_losses').findOne({
    token_address: tokenAddress,
    cooldown_until: { $gt: new Date() }
  });
  return !!recent;
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

  // Low balance check
  const bal = await checkLowBalance();
  console.log(`[ExitMgr] Wallet: ${bal.toFixed(4)} SOL`);

  // Circuit breaker check — warn but DON'T block exits (still need to manage existing positions)
  const cb = await checkCircuitBreakers();
  if (cb.stopTrading) {
    console.log(`[ExitMgr] Circuit breaker active: ${cb.reason} — still managing exits`);
  }

  for (const position of openPositions) {
    await processExitsForPosition(position);
  }
}

let exitInterval;
function startExitManager() {
  const interval = (config.config.divergenceCheckInterval || 15) * 1000;
  exitInterval = setInterval(runExitManager, interval);
  console.log(`[ExitMgr] Started, checking every ${interval / 1000}s`);
}

function stopExitManager() {
  if (exitInterval) clearInterval(exitInterval);
}

module.exports = {
  runExitManager, startExitManager, stopExitManager,
  processExitsForPosition, rugSpeedPredictor, checkExitRules,
  trailingStopCheck, stopLossCheck, checkCircuitBreakers,
  checkLowBalance, isTokenInCooldown
};
