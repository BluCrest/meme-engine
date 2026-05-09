const db = require('../database/db');
const config = require('../config');
const copyTrader = require('../agents/copy-trader');

const MONITOR_INTERVAL = 10000; // check every 10s
const TAKE_PROFIT = 1.5;
const STOP_LOSS = -0.30;
const TRAILING_PCT = 0.12;
const MAX_POSITIONS = 4;
const MAX_SNIPE_POSITIONS = 1; // Only 1 snipe at a time — sell before next
const MIN_BUY = 0.002;
const MIN_BALANCE_FLOOR = 0.01; // Stop ALL buying if balance below this

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

let activePositions = new Map();
const snipePending = new Set();

async function sendTelegramMessage(text) {
  try {
    await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' })
    });
  } catch (_) {}
}

async function getTokenPrice(tokenAddress) {
  try {
    const pf = require('../utils/price-feed');
    return await pf.getCurrentPrice(tokenAddress);
  } catch (_) { return null; }
}

async function getBalance() {
  try {
    const { getBalance } = require('../operator/trade-executor');
    return await getBalance();
  } catch (_) { return 0; }
}

async function executeMomentumBuy(tokenAddress, symbol, pctOfBalance, triggerType) {
  try {
    const isPaperTrading = await db.getPaperTrading();
    let solAmount;
    if (isPaperTrading) {
      solAmount = 0.01; // simulate with 0.01 SOL in paper mode
    } else {
      const bal = await getBalance();
      solAmount = Math.min(bal * pctOfBalance, bal * 0.2);
      if (solAmount < MIN_BUY) {
        console.log(`[Momentum] ${symbol}: bal ${bal.toFixed(4)} too low for ${triggerType}, skip`);
        return null;
      }
    }
    const { executeBuy } = require('../operator/trade-executor');
    const result = await executeBuy(tokenAddress, 'momentum', solAmount);
    if (result && result.success) {
      const entryPrice = result.price || (await getTokenPrice(tokenAddress));
      if (!entryPrice) {
        console.log(`[Momentum] ${symbol}: bought but no entry price`);
        return null;
      }
      const position = {
        tokenAddress, symbol,
        solInvested: solAmount,
        entryPrice, peakPrice: entryPrice,
        boughtAt: Date.now(),
        trigger: triggerType,
        isPaperTrading,
      };
      activePositions.set(tokenAddress, position);
      const label = triggerType === 'snipe' ? '🎯 SNIPE' : triggerType === 'copy_trade' ? '👥 COPY' : '⚡ MOMENTUM';
      console.log(`[Momentum] ${symbol}: BOUGHT ${solAmount.toFixed(4)} SOL @ $${entryPrice} (${triggerType})`);
      await sendTelegramMessage(`${label} *$${symbol}* — ${solAmount.toFixed(4)} SOL | Trigger: ${triggerType} | CA: \`${tokenAddress}\``);
      return position;
    }
    return null;
  } catch (e) {
    console.error(`[Momentum] Buy failed ${symbol}:`, e.message);
    return null;
  }
}

async function executeMomentumSell(tokenAddress, reason) {
  const pos = activePositions.get(tokenAddress);
  if (!pos) return;
  try {
    const { executeSell } = require('../operator/trade-executor');
    const result = await executeSell(tokenAddress, 1.0, reason);
    if (result && result.success) {
      const currentPrice = await getTokenPrice(tokenAddress) || 0;
      const pnl = pos.entryPrice > 0 ? ((currentPrice / pos.entryPrice) - 1) * 100 : 0;
      const emoji = pnl > 0 ? '✅' : '❌';
      console.log(`[Momentum] ${pos.symbol}: SOLD (${reason}) PnL: ${pnl.toFixed(1)}%`);
      await sendTelegramMessage(`${emoji} *$${pos.symbol}* sold — ${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}% (${(1 + pnl/100).toFixed(2)}x) | ${reason} | Invested: ${pos.solInvested.toFixed(4)} SOL`);
      copyTrader.finalizeToken(tokenAddress, currentPrice || pos.entryPrice);
      activePositions.delete(tokenAddress);
    }
  } catch (e) {
    console.error(`[Momentum] Sell failed ${pos.symbol}:`, e.message);
  }
}

async function checkPosition(tokenAddress) {
  const pos = activePositions.get(tokenAddress);
  if (!pos) return;

  const currentPrice = await getTokenPrice(tokenAddress);
  if (!currentPrice) return;

  const pnlPct = (currentPrice / pos.entryPrice) - 1;
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

  copyTrader.recordPrice(tokenAddress, currentPrice);

  // Paper mode: only timeout sell (30 min), no stop-loss
  if (pos.isPaperTrading) {
    if (Date.now() - pos.boughtAt > 1800000) {
      await executeMomentumSell(tokenAddress, 'paper_timeout_30m');
      return;
    }
    return;
  }

  // Take profit
  if (pnlPct >= TAKE_PROFIT) {
    await executeMomentumSell(tokenAddress, `target_${(TAKE_PROFIT * 100).toFixed(0)}x`);
    return;
  }
  // Trailing stop
  if (pos.peakPrice > pos.entryPrice * 1.05) {
    const trailDrop = (pos.peakPrice - currentPrice) / pos.peakPrice;
    if (trailDrop >= TRAILING_PCT) {
      await executeMomentumSell(tokenAddress, `trail_${(TRAILING_PCT * 100).toFixed(0)}pct`);
      return;
    }
  }
  // Hard stop
  if (pnlPct <= STOP_LOSS) {
    await executeMomentumSell(tokenAddress, `stop_${(STOP_LOSS * 100).toFixed(0)}pct`);
    return;
  }
  // Timeout
  if (Date.now() - pos.boughtAt > 1800000) {
    await executeMomentumSell(tokenAddress, 'timeout_30m');
    return;
  }
}

async function monitorPositions() {
  for (const [addr] of activePositions) {
    await checkPosition(addr);
  }
}

async function sellSnipePositionsBeforeNewBuy() {
  // Sell existing snipe positions to free up balance for new snipe
  const snipePositions = [];
  for (const [addr, pos] of activePositions) {
    if (pos.trigger === 'snipe') {
      snipePositions.push({ addr, pos });
    }
  }
  // Sort by boughtAt ascending (oldest first)
  snipePositions.sort((a, b) => a.pos.boughtAt - b.pos.boughtAt);
  // Sell all existing snipe positions (or oldest if we want to keep one)
  const toSell = snipePositions.slice(0, Math.max(0, snipePositions.length - MAX_SNIPE_POSITIONS + 1));
  for (const { addr } of toSell) {
    console.log(`[Momentum] Selling snipe ${addr.slice(0, 8)}... to free balance for new snipe`);
    await executeMomentumSell(addr, 'replace_for_new_snipe');
  }
}

async function handleMomentumTrigger(trigger) {
  // Balance floor: don't even try if balance is critically low (skip check in paper trading)
  const currentBal = await getBalance();
  const isPaperTrading = await db.getPaperTrading();
  if (!isPaperTrading && currentBal < MIN_BALANCE_FLOOR) {
    console.log(`[Momentum] Balance ${currentBal.toFixed(4)} SOL below floor ${MIN_BALANCE_FLOOR}, pausing new buys`);
    return;
  }

  if (activePositions.size >= MAX_POSITIONS) {
    // If this is a snipe and we're at max, try replacing oldest snipe
    if (trigger.isSnipe) {
      await sellSnipePositionsBeforeNewBuy();
      if (activePositions.size >= MAX_POSITIONS) {
        console.log(`[Momentum] ${trigger.symbol}: still at max positions after cleanup`);
        return;
      }
    } else {
      console.log(`[Momentum] ${trigger.symbol}: max positions (${MAX_POSITIONS})`);
      return;
    }
  }

  // Check stop-loss cooldown
  const recentSl = await db.getDb().collection('stop_losses').findOne({
    token_address: trigger.address,
    stopped_at: { $gte: new Date(Date.now() - 600000) }
  });
  if (recentSl) return;
  if (activePositions.has(trigger.address)) return;

  // Scale: snipe gets smallest, copy_trade gets largest
  const pctMap = {
    snipe: 0.05,       // 5% of wallet for snipes (reduced from 8%)
    first_activity: 0.10,
    high_activity: 0.10,
    buy_pressure: 0.12,
    strong: 0.15,
    copy_trade: 0.20
  };
  const pct = pctMap[trigger.momentum.trigger] || 0.05;

  // For snipes: sell existing snipe positions before buying new one
  if (trigger.isSnipe) {
    const snipeCount = [...activePositions.values()].filter(p => p.trigger === 'snipe').length;
    if (snipeCount >= MAX_SNIPE_POSITIONS) {
      await sellSnipePositionsBeforeNewBuy();
    }
  }

  await executeMomentumBuy(trigger.address, trigger.symbol, pct, trigger.momentum.trigger);
}

async function startMomentumTrader() {
  console.log('[MomentumTrader] Starting (monitor every 10s)...');
  setInterval(monitorPositions, MONITOR_INTERVAL);
}

module.exports = { startMomentumTrader, handleMomentumTrigger, activePositions };
