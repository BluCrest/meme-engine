const db = require('../database/db');
const { executeSell } = require('./trade-executor');
const { formatX } = require('../utils/format-x');
const config = require('../config');

const SOL_USD_RATE = 150;
const priceCache = new Map();
const PRICE_CACHE_TTL = 20000;

async function getCurrentPrice(tokenAddress) {
  const cached = priceCache.get(tokenAddress);
  if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL) return cached.price;
  try {
    const pf = require('../utils/price-feed');
    const price = await pf.getCurrentPrice(tokenAddress);
    if (price) priceCache.set(tokenAddress, { price, ts: Date.now() });
    return price || 0;
  } catch (_) { return 0; }
}

const lastChecked = new Map();

function getCheckSchedule(tokenAddress) {
  const defaults = { sellPressure: 0, devOutflow: 0, walletDump: 0 };
  return lastChecked.get(tokenAddress) || defaults;
}

function updateCheckSchedule(tokenAddress, signal) {
  const current = getCheckSchedule(tokenAddress);
  current[signal] = Date.now();
  lastChecked.set(tokenAddress, current);
}

function shouldCheck(tokenAddress, signal, intervalMs) {
  const schedule = getCheckSchedule(tokenAddress);
  return Date.now() - (schedule[signal] || 0) > intervalMs;
}

async function sendTelegramMessage(chatId, text) {
  try {
    const token = config.telegram.botToken;
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (_) {}
}

function getExitParams(token) {
  const devReputation = token?.dev_reputation || 50;
  const devRugCount = token?.dev_rug_count || 0;
  const devTotalLaunches = token?.dev_total_launches || 1;
  const devRugRate = devTotalLaunches > 0 ? devRugCount / devTotalLaunches : 0.5;
  const avgPeakReturn = token?.dev_avg_peak_return || 3;

  if (devReputation < 30 || devRugRate > 0.7) {
    return { stopLossPct: -0.15, trailingTrigger: 0.15, trailingDrawdown: 0.08, devPeakTarget: avgPeakReturn * 0.6 };
  }
  if (devReputation > 70 && devRugRate < 0.3) {
    return { stopLossPct: -0.25, trailingTrigger: 0.30, trailingDrawdown: 0.15, devPeakTarget: avgPeakReturn * 0.8 };
  }
  return { stopLossPct: -0.20, trailingTrigger: 0.20, trailingDrawdown: 0.12, devPeakTarget: avgPeakReturn * 0.7 };
}

async function checkSellPressureSignal(position) {
  if (!shouldCheck(position.token_address, 'sellPressure', 120000)) return null;
  updateCheckSchedule(position.token_address, 'sellPressure');
  try {
    const { checkTokenSellPressure } = require('../sentinel/sell-pressure-monitor');
    const signals = await checkTokenSellPressure(position.token_address);
    if (!signals?.length) return null;
    const critical = signals.find(s => s.severity === 'critical' || s.severity === 'high');
    return critical || null;
  } catch (_) { return null; }
}

async function checkDevOutflowSignal(position, devWallet) {
  if (!devWallet) return null;
  if (!shouldCheck(position.token_address, 'devOutflow', 300000)) return null;
  updateCheckSchedule(position.token_address, 'devOutflow');
  try {
    const { checkDevOutflow } = require('../sentinel/dev-outflow-monitor');
    return await checkDevOutflow(devWallet, position.token_address);
  } catch (_) { return null; }
}

async function checkWalletDumpSignal(position) {
  if (!shouldCheck(position.token_address, 'walletDump', 300000)) return null;
  updateCheckSchedule(position.token_address, 'walletDump');
  try {
    const { areSmartWalletsDumping } = require('../sentinel/wallet-dump-monitor');
    return await areSmartWalletsDumping(position.token_address, position.symbol);
  } catch (_) { return null; }
}

async function processExitsForPosition(position) {
  const chatId = config.telegram.chatId;
  try {
    if (!position.token_address ||
        position.token_address.startsWith('0x') ||
        position.token_address.length < 30) return;

    const currentPrice = await getCurrentPrice(position.token_address);
    if (!currentPrice || currentPrice <= 0) return;

    const entryPrice = position.entry_price || 0;
    if (!entryPrice || entryPrice <= 0) return;

    const pnl = entryPrice > 0 ? ((currentPrice / (entryPrice * SOL_USD_RATE)) - 1) : 0;
    const symbol = position.symbol || position.token_address.slice(0, 8);

    if (currentPrice > (position.highest_price || 0)) {
      await db.getDb().collection('positions').updateOne(
        { _id: position._id },
        { $set: { highest_price: currentPrice } }
      );
      position.highest_price = currentPrice;
    }

    const token = await db.getToken(position.token_address);
    const ep = getExitParams(token);
    const devWallet = token?.dev_wallet || null;

    // TIER 1: Every cycle (30s) — price-based exits

    // Hard stop loss
    if (pnl <= ep.stopLossPct) {
      console.log(`[ExitMgr] STOP LOSS: ${symbol} pnl=${(pnl*100).toFixed(0)}%`);
      await executeSell(position.token_address, 1.0, 'stop_loss');
      await sendTelegramMessage(chatId,
        `🛑 *STOP LOSS: $${symbol}*\nPnL: ${(pnl*100).toFixed(0)}% (${formatX(pnl)})`
      );
      return;
    }

    // Dev peak target — sell 75% when near dev's historical avg peak
    if (ep.devPeakTarget > 1 && (pnl + 1) >= ep.devPeakTarget && !position.dev_peak_sold) {
      console.log(`[ExitMgr] DEV PEAK TARGET: ${symbol} at ${(pnl*100).toFixed(0)}%`);
      await executeSell(position.token_address, 0.75, 'dev_peak_target');
      await db.getDb().collection('positions').updateOne(
        { _id: position._id }, { $set: { dev_peak_sold: true } }
      );
      await sendTelegramMessage(chatId,
        `🎯 *DEV PEAK: $${symbol}*\nSold 75% at ${(pnl*100).toFixed(0)}%\nDev avg peak: ${((ep.devPeakTarget-1)*100).toFixed(0)}% — moonbag remains`
      );
      return;
    }

    // Trailing stop
    const highestPrice = position.highest_price || (entryPrice * SOL_USD_RATE);
    const gainFromEntry = entryPrice > 0 ? ((highestPrice / (entryPrice * SOL_USD_RATE)) - 1) : 0;
    if (gainFromEntry >= ep.trailingTrigger) {
      const drawdownFromPeak = (highestPrice - currentPrice) / highestPrice;
      if (drawdownFromPeak >= ep.trailingDrawdown) {
        console.log(`[ExitMgr] TRAILING STOP: ${symbol} -${(drawdownFromPeak*100).toFixed(0)}% from peak`);
        await executeSell(position.token_address, 1.0, 'trailing_stop');
        await sendTelegramMessage(chatId,
          `📉 *TRAILING STOP: $${symbol}*\nPeak: +${(gainFromEntry*100).toFixed(0)}% → Now: ${(pnl*100).toFixed(0)}%\nDropped ${(drawdownFromPeak*100).toFixed(0)}% from peak`
        );
        return;
      }
    }

    // Paper timeout
    const isPaper = await db.getPaperTrading();
    if (isPaper && position.opened_at) {
      const ageMs = Date.now() - new Date(position.opened_at).getTime();
      if (ageMs > 900000) {
        await executeSell(position.token_address, 1.0, 'paper_timeout');
        await sendTelegramMessage(chatId,
          `⏱️ *PAPER TIMEOUT: $${symbol}*\nFinal PnL: ${(pnl*100).toFixed(0)}% (${formatX(pnl)})`
        );
        return;
      }
    }

    // TIER 2: Every 2 minutes — sell pressure (1 API call)
    const pressureSignal = await checkSellPressureSignal(position);
    if (pressureSignal?.triggered) {
      console.log(`[ExitMgr] SELL PRESSURE: ${symbol} — ${pressureSignal.reason}`);
      await executeSell(position.token_address, 1.0, pressureSignal.reason);
      await sendTelegramMessage(chatId, `${pressureSignal.message}\n$${symbol} sold 100%`);
      return;
    }

    // TIER 3: Every 5 minutes — dev outflow + wallet dump (RPC)
    const devOutflow = await checkDevOutflowSignal(position, devWallet);
    if (devOutflow?.triggered) {
      console.log(`[ExitMgr] DEV OUTFLOW: ${symbol}`);
      await executeSell(position.token_address, 1.0, devOutflow.reason);
      await sendTelegramMessage(chatId, `${devOutflow.message}\n$${symbol} sold 100%`);
      return;
    }

    const walletDump = await checkWalletDumpSignal(position);
    if (walletDump?.triggered) {
      console.log(`[ExitMgr] WALLET DUMP: ${symbol}`);
      await executeSell(position.token_address, 1.0, walletDump.reason);
      await sendTelegramMessage(chatId, `${walletDump.message}\n$${symbol} sold 100%`);
      return;
    }

  } catch (err) {
    console.error('[ExitMgr] Error:', position.token_address, err.message);
  }
}

async function runExitManager() {
  try {
    const positions = await db.getOpenPositions();
    if (!positions?.length) return;

    const bal = await (async () => {
      try { const { getBalance } = require('./trade-executor'); return await getBalance(); }
      catch (_) { return 0; }
    })();

    console.log(`[ExitMgr] Checking ${positions.length} open positions... Wallet: ${bal.toFixed(4)} SOL`);

    for (const position of positions) {
      await processExitsForPosition(position);
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error('[ExitMgr] Run error:', err.message);
  }
}

let exitInterval;
function startExitManager() {
  exitInterval = setInterval(runExitManager, 10000);
  console.log('[ExitMgr] Started — 10s cycle | price:10s | sell pressure:2min | dev/wallets:5min');
}

function stopExitManager() {
  if (exitInterval) clearInterval(exitInterval);
}

// Stubs for backward compatibility — circuit breaker disabled (clean learning data)
async function checkCircuitBreakers() { return { stopTrading: false, reason: '' }; }
async function isTokenInCooldown() { return false; }

module.exports = { startExitManager, stopExitManager, processExitsForPosition, checkCircuitBreakers, isTokenInCooldown };
