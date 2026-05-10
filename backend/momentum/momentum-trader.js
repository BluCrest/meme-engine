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
const recentlySold = new Map(); // addr -> timestamp (30 min TTL)
const RECENTLY_SOLD_TTL = 1800000;

function markRecentlySold(addr) {
  recentlySold.set(addr, Date.now());
  setTimeout(() => recentlySold.delete(addr), RECENTLY_SOLD_TTL);
}

function isRecentlySold(addr) {
  const ts = recentlySold.get(addr);
  if (!ts) return false;
  if (Date.now() - ts > RECENTLY_SOLD_TTL) { recentlySold.delete(addr); return false; }
  return true;
}

// Performance tracker per trigger type — learn from wins/losses (persisted to DB)
const triggerStats = new Map(); // triggerType -> { wins, losses, total }

async function loadTriggerStats() {
  try {
    const doc = await db.getDb().collection('settings').findOne({ key: 'triggerStats' });
    if (doc?.value) {
      for (const [type, stats] of Object.entries(doc.value)) {
        triggerStats.set(type, stats);
      }
      console.log(`[Momentum] Loaded ${triggerStats.size} trigger types from DB`);
    }
  } catch (_) {}
}

async function saveTriggerStats() {
  try {
    const obj = {};
    for (const [type, stats] of triggerStats) {
      obj[type] = stats;
    }
    await db.getDb().collection('settings').updateOne(
      { key: 'triggerStats' },
      { $set: { value: obj, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (_) {}
}

function recordTriggerResult(triggerType, pnlPct) {
  if (!triggerType) return;
  if (!triggerStats.has(triggerType)) triggerStats.set(triggerType, { wins: 0, losses: 0, total: 0 });
  const s = triggerStats.get(triggerType);
  s.total++;
  if (pnlPct > 0) s.wins++;
  else s.losses++;
  saveTriggerStats();
}

function shouldSkipTrigger(triggerType) {
  const s = triggerStats.get(triggerType);
  if (!s || s.total < 3) return false;
  return s.losses / s.total > 0.75;
}

function getPositionScale(triggerType) {
  const s = triggerStats.get(triggerType);
  if (!s || s.total < 3) return 1.0;
  const lossRate = s.losses / s.total;
  if (lossRate > 0.65) return 0.5;
  if (lossRate > 0.5) return 0.75;
  return 1.0;
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
      const entryPrice = result.trade?.price_at_trade || (await getTokenPrice(tokenAddress)) || 0.000001;
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

  // Snipe partial exit: sell 50% on first signal, keep monitoring
  if (pos.trigger === 'snipe' && !pos.partialSold && reason !== 'replace_for_new_snipe') {
    try {
      const { executeSell } = require('../operator/trade-executor');
      const result = await executeSell(tokenAddress, 0.5, reason + '_partial');
      if (result && result.success) {
        pos.partialSold = true;
        const currentPrice = await getTokenPrice(tokenAddress) || 0;
        const pnl = pos.entryPrice > 0 ? ((currentPrice / pos.entryPrice) - 1) * 100 : 0;
        console.log(`[Momentum] ${pos.symbol}: PARTIAL 50% (${reason}) PnL: ${pnl.toFixed(1)}% — watching for confirmation`);
        await sendTelegramMessage(`⚠️ *$${pos.symbol}* partial sell 50% — ${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}% | ${reason} | Monitoring remaining`);
        return;
      }
    } catch (_) {}
  }

  try {
    const { executeSell } = require('../operator/trade-executor');
    const result = await executeSell(tokenAddress, 1.0, reason);
    if (result && result.success) {
      const currentPrice = await getTokenPrice(tokenAddress) || 0;
      const pnl = pos.entryPrice > 0 ? ((currentPrice / pos.entryPrice) - 1) * 100 : 0;
      const emoji = pnl > 0 ? '✅' : '❌';
      const label = pos.partialSold ? ' REMAINING' : '';
      console.log(`[Momentum] ${pos.symbol}: SOLD${label} (${reason}) PnL: ${pnl.toFixed(1)}%`);
      const { formatX } = require('../utils/format-x');
      await sendTelegramMessage(`${emoji} *$${pos.symbol}* sold${label.toLowerCase()} — ${pnl > 0 ? '+' : ''}${pnl.toFixed(1)}% (${formatX(pnl / 100)}) | ${reason} | Invested: ${pos.solInvested.toFixed(4)} SOL`);
      recordTriggerResult(pos.trigger, pnl / 100);
    } else {
      console.log(`[Momentum] ${pos.symbol}: sell skipped/failed (${reason}) — removing from active positions`);
    }
  } catch (e) {
    console.error(`[Momentum] Sell failed ${pos.symbol}:`, e.message);
  }
  markRecentlySold(tokenAddress);
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
          trailTrigger = 0.15;
        }
        // Momentum buys: token already pumped before entry, arm trailing sooner
        if (pos.trigger) {
          trailTrigger = Math.min(trailTrigger, 0.1);
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

  // Fast-path for narrative-matched tokens: skip full checks, just honeypot guard
  if (trigger.narrativeMatch?.score >= 20) {
    console.log(`[Momentum] ${trigger.symbol}: narrative match (${trigger.narrativeMatch.score}) — fast path`);
    try {
      const { runSafetyCheck } = require('../sentinel/safety-checker');
      const safety = await runSafetyCheck(trigger.address);
      if (safety?.honeypot) { console.log(`[Momentum] ${trigger.symbol}: honeypot — skipping`); return; }
    } catch (_) {}
  } else {
    // Full pre-buy dev validation
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
  }

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

  // Scale: learning-aware position sizing
  const scale = getPositionScale(trigger.momentum.trigger);
  const pctMap = {
    snipe: 0.05 * scale,
    first_activity: 0.10 * scale,
    high_activity: 0.10 * scale,
    buy_pressure: 0.12 * scale,
    strong: 0.15 * scale,
    copy_trade: 0.20 * scale
  };
  const pct = pctMap[trigger.momentum.trigger] || 0.05;
  if (scale < 1.0) console.log(`[Momentum] ${trigger.symbol}: scaled position ${(scale * 100).toFixed(0)}% (learning: ${trigger.momentum.trigger} has ${triggerStats.get(trigger.momentum.trigger)?.losses || 0} losses)`);

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
  await loadTriggerStats();
  console.log('[MomentumTrader] Starting (monitor every 10s)...');
  setInterval(monitorPositions, MONITOR_INTERVAL);
}

function getTriggerStats() {
  const out = {};
  for (const [type, s] of triggerStats) {
    out[type] = { wins: s.wins, losses: s.losses, total: s.total, winRate: s.total > 0 ? (s.wins / s.total * 100).toFixed(0) : 0, skipped: s.total >= 3 && s.losses / s.total > 0.75 };
  }
  return out;
}

module.exports = { startMomentumTrader, handleMomentumTrigger, handleNewTokenFromListener, activePositions, getTriggerStats, isRecentlySold };

// ── 3-GATE CHECK for WebSocket-discovered tokens ──────────────
// Called by token-listener.js for every new on-chain Pump.fun token
// Fast, minimal RPC — designed for speed not depth

async function handleNewTokenFromListener(tokenAddress) {
  try {
    const isPaper = await db.getPaperTrading();

    // GATE 1: Dev reputation — pure DB lookup, zero RPC
    const token = await db.getToken(tokenAddress);
    const devWallet = token?.dev_wallet || null;
    if (devWallet) {
      const { buildDevProfile } = require('../profiler/dev-fingerprint');
      const devProfile = await buildDevProfile(devWallet);
      if (devProfile?.label === 'serial_rugger') {
        console.log(`[Listener] ${tokenAddress.slice(0,8)}... — SKIP: serial rugger dev`);
        return;
      }
      if (devProfile?.rug_count >= 3) {
        console.log(`[Listener] ${tokenAddress.slice(0,8)}... — SKIP: dev has ${devProfile.rug_count} rugs`);
        return;
      }
      // Attach dev profile data to token for exit manager
      if (devProfile) {
        await db.upsertToken({
          address: tokenAddress,
          dev_avg_peak_mc: devProfile.avgPeakMC || null,
          dev_avg_peak_return: devProfile.avg_return_at_peak || null,
          dev_avg_time_to_rug: devProfile.avg_time_to_rug_hours || null,
          dev_rug_count: devProfile.rug_count || 0,
          dev_reputation: devProfile.reputationScore || 50
        });
      }
    }

    // GATE 2: Skipped — every token from Pump.fun logs is on the curve by definition
    // Removing this RPC call eliminates the main source of 429s

    // GATE 3: Any real volume? — 1 DexScreener call
    const { fetchDexVolume } = require('../sources/source-rotator');
    const vol = await fetchDexVolume(tokenAddress);
    const txns = vol?.txns5m || 0;
    const vol5m = vol?.vol5m || 0;

    if (txns < 1) {
      console.log(`[Listener] ${tokenAddress.slice(0,8)}... — SKIP: zero transactions yet`);
      // Re-check once after 30s in case it's just slow to index
      setTimeout(() => handleNewTokenFromListener(tokenAddress), 30000);
      return;
    }

    const symbol = vol?.symbol || token?.symbol || tokenAddress.slice(0, 6);
    console.log(`[Listener] ✅ ${symbol} PASSED 3 gates — txns:${txns} vol:$${vol5m} — executing buy`);

    // Save symbol
    await db.upsertToken({ address: tokenAddress, symbol, status: 'triggered' });

    // Position sizing
    const bal = await getBalance();
    const solAmount = isPaper ? 0.01 : Math.min(bal * 0.05, bal - MIN_BALANCE_FLOOR);

    if (!isPaper && solAmount < MIN_BUY) {
      console.log(`[Listener] ${symbol}: balance ${bal.toFixed(4)} SOL too low — skipping`);
      return;
    }

    await sendTelegramMessage(
      `🎯 *New token: $${symbol}*\n` +
      `Gates: ✅ dev ✅ curve ✅ volume (${txns} txns, $${vol5m.toFixed(0)})\n` +
      `${isPaper ? '📝 Paper buy: 0.01 SOL' : `💰 Buying: ${solAmount.toFixed(4)} SOL`}`
    );

    const { executeBuy } = require('../operator/trade-executor');
    const result = await executeBuy(tokenAddress, 'listener_3gate', solAmount);

    if (result?.success) {
      const entryPrice = result.trade?.price_at_trade || 0.000001;
      activePositions.set(tokenAddress, {
        tokenAddress, symbol,
        solInvested: solAmount,
        entryPrice,
        highestPrice: entryPrice,
        trigger: 'listener_3gate',
        openedAt: Date.now()
      });
      recordBuy();
      console.log(`[Listener] Position opened: ${symbol} @ ${entryPrice}`);
    }

  } catch (err) {
    console.error('[Listener] 3-gate check error:', tokenAddress, err.message);
  }
}
