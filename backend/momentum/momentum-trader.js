const db = require('../database/db');
const config = require('../config');
const copyTrader = require('../agents/copy-trader');

const MONITOR_INTERVAL = 15000;
const TAKE_PROFIT = 1.5;
const STOP_LOSS = -0.30;
const TRAILING_PCT = 0.12;
const MAX_POSITIONS = 3;
const MAX_PORTFOLIO_PCT = 0.15;
const MIN_BUY = 0.002;

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

let activePositions = new Map();

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
    const bal = await getBalance();
    const solAmount = bal * pctOfBalance;
    const actualAmount = Math.min(solAmount, bal * MAX_PORTFOLIO_PCT);
    if (actualAmount < MIN_BUY) {
      console.log(`[MomentumTrader] ${symbol}: balance too low (${bal.toFixed(4)} SOL, need ${MIN_BUY}), skipping buy`);
      return null;
    }
    const { executeBuy } = require('../operator/trade-executor');
    const result = await executeBuy(tokenAddress, 'momentum', actualAmount);
    if (result && result.success) {
      const entryPrice = result.price || (await getTokenPrice(tokenAddress));
      if (!entryPrice) {
        console.log(`[MomentumTrader] ${symbol}: bought but no entry price, cannot monitor`);
        return null;
      }
      const position = {
        tokenAddress,
        symbol,
        solInvested: actualAmount,
        entryPrice,
        peakPrice: entryPrice,
        boughtAt: Date.now(),
        trigger: triggerType || 'momentum'
      };
      activePositions.set(tokenAddress, position);
      const pctStr = (pctOfBalance * 100).toFixed(0);
      const label = triggerType === 'copy_trade' ? '👥 COPY' : '⚡ MOMENTUM';
      console.log(`[MomentumTrader] ${symbol}: BOUGHT ${actualAmount.toFixed(4)} SOL @ $${entryPrice} (${position.trigger})`);
      await sendTelegramMessage(`${label} *$${symbol}* — bought ${actualAmount.toFixed(4)} SOL (${pctStr}% of wallet) | Trigger: ${triggerType} | CA: \`${tokenAddress}\``);
      return position;
    }
    return null;
  } catch (e) {
    console.error(`[MomentumTrader] Buy failed ${symbol}:`, e.message);
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
      console.log(`[MomentumTrader] ${pos.symbol}: SOLD (${reason}) PnL: ${pnl.toFixed(1)}%`);
      await sendTelegramMessage(`${emoji} *$${pos.symbol}* sold (${reason}) — PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}% | Invested: ${pos.solInvested.toFixed(4)} SOL`);
      copyTrader.finalizeToken(tokenAddress, currentPrice || pos.entryPrice);
      activePositions.delete(tokenAddress);
    }
  } catch (e) {
    console.error(`[MomentumTrader] Sell failed ${pos.symbol}:`, e.message);
  }
}

async function checkPosition(tokenAddress) {
  const pos = activePositions.get(tokenAddress);
  if (!pos) return;

  const currentPrice = await getTokenPrice(tokenAddress);
  if (!currentPrice) return;

  const pnlPct = (currentPrice / pos.entryPrice) - 1;
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

  // Update copy trader with current price
  copyTrader.recordPrice(tokenAddress, currentPrice);

  if (pnlPct >= TAKE_PROFIT - 1) {
    await executeMomentumSell(tokenAddress, `take_profit_${(TAKE_PROFIT * 100).toFixed(0)}x`);
    return;
  }
  if (pos.peakPrice > pos.entryPrice) {
    const trailDrop = (pos.peakPrice - currentPrice) / pos.peakPrice;
    if (trailDrop >= TRAILING_PCT) {
      await executeMomentumSell(tokenAddress, `trailing_stop_${(TRAILING_PCT * 100).toFixed(0)}pct`);
      return;
    }
  }
  if (pnlPct <= STOP_LOSS) {
    await executeMomentumSell(tokenAddress, `stop_loss_${(STOP_LOSS * 100).toFixed(0)}pct`);
    return;
  }
  if (Date.now() - pos.boughtAt > 1800000) {
    await executeMomentumSell(tokenAddress, 'timeout_30min');
    return;
  }
}

async function monitorPositions() {
  for (const [addr] of activePositions) {
    await checkPosition(addr);
  }
}

async function handleMomentumTrigger(trigger) {
  if (activePositions.size >= MAX_POSITIONS) {
    console.log(`[MomentumTrader] ${trigger.symbol}: max positions (${MAX_POSITIONS}), skipping`);
    return;
  }

  const recentSl = await db.getDb().collection('stop_losses').findOne({
    token_address: trigger.address,
    stopped_at: { $gte: new Date(Date.now() - 600000) }
  });
  if (recentSl) return;
  if (activePositions.has(trigger.address)) return;

  // Size: percentage of wallet balance (scales automatically for small wallets)
  const pctMap = {
    copy_trade: 0.20,
    strong: 0.15,
    buy_pressure: 0.12,
    high_activity: 0.08
  };
  const pctOfBalance = pctMap[trigger.momentum.trigger] || 0.08;
  const label = trigger.copyTradeSignal ? '👥 COPY TRADE' : '⚡ MOMENTUM';

  console.log(`[MomentumTrader] ${label}: ${trigger.symbol} — ${trigger.momentum.reason}`);
  await executeMomentumBuy(trigger.address, trigger.symbol, pctOfBalance, trigger.momentum.trigger);
}

async function startMomentumTrader() {
  console.log('[MomentumTrader] Starting (monitor every 15s)...');
  setInterval(monitorPositions, MONITOR_INTERVAL);
}

module.exports = { startMomentumTrader, handleMomentumTrigger, activePositions };
