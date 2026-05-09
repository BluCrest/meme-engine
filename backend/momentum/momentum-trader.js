const db = require('../database/db');
const config = require('../config');
const copyTrader = require('../agents/copy-trader');

const MONITOR_INTERVAL = 10000;
const TAKE_PROFIT = 100;
const STOP_LOSS = -0.20;
const TRAILING_TRIGGER = 0.2;
const TRAILING_PCT = 0.12;
const MAX_POSITIONS = 3;
const MAX_SNIPE_POSITIONS = 1;
const MIN_BUY = 0.002;
const MIN_BALANCE_FLOOR = 0.01;
const MAX_BUYS_PER_HOUR = 4;
const PAPER_TIMEOUT_MS = 900000;

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

let activePositions = new Map();
const snipePending = new Set();

// Performance tracker per trigger type — learn from wins/losses
const triggerStats = new Map(); // triggerType -> { wins, losses, total }

function recordTriggerResult(triggerType, pnlPct) {
  if (!triggerType) return;
  if (!triggerStats.has(triggerType)) triggerStats.set(triggerType, { wins: 0, losses: 0, total: 0 });
  const s = triggerStats.get(triggerType);
  s.total++;
  if (pnlPct > 0) s.wins++;
  else s.losses++;
}

function shouldSkipTrigger(triggerType) {
  const s = triggerStats.get(triggerType);
  if (!s || s.total < 3) return false;
  return s.losses / s.total > 0.75;
}

// Buy cooldown: limit buys per rolling hour
const buyTimestamps = [];

function canBuy() {
  const now = Date.now();
  const recent = buyTimestamps.filter(t => now - t < 3600000);
  buyTimestamps.length = 0;
  buyTimestamps.push(...recent);
  return buyTimestamps.length < MAX_BUYS_PER_HOUR;
}

function recordBuy() {
  buyTimestamps.push(Date.now());
}

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
    // Reject non-Solana addresses (Ethereum 0x, etc.)
    if (!tokenAddress || tokenAddress.startsWith('0x') || tokenAddress.length < 30 || tokenAddress.length > 50) {
      console.log(`[Momentum] ${symbol}: invalid Solana address "${tokenAddress.slice(0, 12)}..." — skipping`);
      return null;
    }
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
      recordBuy();
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
      const { formatX } = require('../utils/format-x');
      await sendTelegramMessage(`${emoji} *$${pos.symbol}* sold — ${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}% (${formatX(pnl / 100)}) | ${reason} | Invested: ${pos.solInvested.toFixed(4)} SOL`);
      recordTriggerResult(pos.trigger, pnl / 100);
    } else {
      console.log(`[Momentum] ${pos.symbol}: sell skipped/failed (${reason}) — removing from active positions`);
    }
  } catch (e) {
    console.error(`[Momentum] Sell failed ${pos.symbol}:`, e.message);
  }
  copyTrader.finalizeToken(tokenAddress, 0);
  activePositions.delete(tokenAddress);
}

async function checkPosition(tokenAddress) {
  const pos = activePositions.get(tokenAddress);
  if (!pos) return;

  const currentPrice = await getTokenPrice(tokenAddress);
  if (!currentPrice) return;

  const pnlPct = (currentPrice / pos.entryPrice) - 1;
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;

  copyTrader.recordPrice(tokenAddress, currentPrice);

  // Dev-aware params: lookup dev profile to adjust trailing/stop
  let trailTrigger = TRAILING_TRIGGER, trailPct = TRAILING_PCT, stopLoss = STOP_LOSS, timeoutMs = PAPER_TIMEOUT_MS;
  try {
    const token = await db.getToken(tokenAddress);
    const devWallet = token?.dev_wallet;
    if (devWallet) {
      const { buildDevProfile } = require('../profiler/dev-fingerprint');
      const dev = await buildDevProfile(devWallet);
      if (dev) {
        const rep = dev.reputation_score || 50;
        const rugRate = dev.totalLaunches > 0 ? (dev.rugCount || 0) / dev.totalLaunches : 0;
        const avgPeak = dev.avg_return_at_peak || 1;
        const patternMemory = require('../agents/pattern-memory');
        const tightenFactor = patternMemory.getTighteningFactor();
        if (rep > 70 && rugRate < 0.3) {
          trailPct = Math.min(0.25, 0.12 + (rep - 70) / 200) * (1 / tightenFactor);
          trailTrigger = Math.min(5, Math.max(0.2, avgPeak * 0.4));
          stopLoss = Math.max(-0.30, -0.25 * (1 / tightenFactor));
        } else if (rugRate > 0.7 || rep < 30) {
          trailPct = Math.min(0.15, 0.08 * tightenFactor);
          trailTrigger = 0.15;
          stopLoss = Math.max(-0.20, -0.15 * (1 / tightenFactor));
        } else {
          trailPct = Math.min(0.15, 0.12 * tightenFactor);
        }
        if (dev.avg_time_to_rug_hours && dev.avg_time_to_rug_hours > 0) {
          timeoutMs = Math.min(3600000, dev.avg_time_to_rug_hours * 0.75 * 3600000);
        }
      }
    }
  } catch (_) {}

  // Paper mode: check exits same as live (trailing stop, stop loss, timeout)
  if (pos.isPaperTrading) {
    if (pos.peakPrice > pos.entryPrice * (1 + trailTrigger)) {
      const trailDrop = (pos.peakPrice - currentPrice) / pos.peakPrice;
      if (trailDrop >= trailPct) {
        const secondsSincePeak = pos.peakReachedAt ? (Date.now() - pos.peakReachedAt) / 1000 : 999;
        if (secondsSincePeak < 60 && trailDrop >= trailPct * 0.6) {
          await executeMomentumSell(tokenAddress, 'paper_flash_crash');
          return;
        }
        await executeMomentumSell(tokenAddress, `paper_trail_${(trailPct * 100).toFixed(0)}pct`);
        return;
      }
    }
    if (currentPrice > pos.peakPrice * 0.98) pos.peakReachedAt = Date.now();
    if (pnlPct <= stopLoss) {
      await executeMomentumSell(tokenAddress, `paper_stop_${(stopLoss * 100).toFixed(0)}pct`);
      return;
    }
    if (Date.now() - pos.boughtAt > timeoutMs) {
      await executeMomentumSell(tokenAddress, 'paper_timeout');
      return;
    }
    return;
  }

  // Live — trailing stop with flash crash detection
  if (pos.peakPrice > pos.entryPrice * (1 + trailTrigger)) {
    const trailDrop = (pos.peakPrice - currentPrice) / pos.peakPrice;
    if (trailDrop >= trailPct) {
      const secondsSincePeak = pos.peakReachedAt ? (Date.now() - pos.peakReachedAt) / 1000 : 999;
      if (secondsSincePeak < 60 && trailDrop >= trailPct * 0.6) {
        await executeMomentumSell(tokenAddress, 'flash_crash');
        return;
      }
      await executeMomentumSell(tokenAddress, `trail_${(trailPct * 100).toFixed(0)}pct`);
      return;
    }
  }
  // Track peak timestamp for velocity detection
  if (currentPrice > pos.peakPrice * 0.98) pos.peakReachedAt = Date.now();
  // Hard stop
  if (pnlPct <= stopLoss) {
    await executeMomentumSell(tokenAddress, `stop_${(stopLoss * 100).toFixed(0)}pct`);
    return;
  }
  // Timeout
  if (Date.now() - pos.boughtAt > timeoutMs) {
    await executeMomentumSell(tokenAddress, 'timeout');
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
  // Skip if this trigger type has >75% loss rate (learned from past results)
  if (shouldSkipTrigger(trigger.momentum?.trigger)) {
    console.log(`[Momentum] ${trigger.symbol}: trigger "${trigger.momentum.trigger}" has poor track record — skipping`);
    return;
  }

  // Rate limit buys: max 4 per hour
  if (!canBuy()) {
    console.log(`[Momentum] Buy rate limit hit (${MAX_BUYS_PER_HOUR}/hr) — skipping ${trigger.symbol}`);
    return;
  }

  // Pre-buy dev validation — check dev profile before buying
  try {
    const token = await db.getToken(trigger.address);
    const devWallet = token?.dev_wallet;
    if (devWallet) {
      const { buildDevProfile } = require('../profiler/dev-fingerprint');
      const devProfile = await buildDevProfile(devWallet);
      if (devProfile?.label === 'serial_rugger') {
        console.log(`[Momentum] ${trigger.symbol}: dev is serial_rugger — skipping`);
        return;
      }
      if (devProfile && (devProfile.rugCount || 0) >= 3) {
        console.log(`[Momentum] ${trigger.symbol}: dev has ${devProfile.rugCount} rugs — skipping`);
        return;
      }
    }
  } catch (_) {}

  // Quick safety check — skip clear honeypots
  try {
    const { runSafetyCheck } = require('../sentinel/safety-checker');
    const safety = await runSafetyCheck(trigger.address);
    if (safety?.honeypot) {
      console.log(`[Momentum] ${trigger.symbol}: honeypot detected — skipping`);
      return;
    }
    if (safety && (safety.top5Concentration || 0) > 80) {
      console.log(`[Momentum] ${trigger.symbol}: top 5 hold ${safety.top5Concentration}% — skipping`);
      return;
    }
  } catch (_) {}

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
