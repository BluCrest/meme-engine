const config = require('../config');
const db = require('../database/db');

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ALERT_THRESHOLD = 50;
const MAX_ALERTS = 20;

const pendingAlerts = new Map();
const queuedAlerts = [];

function formatMC(mc) {
  if (!mc) return '$0';
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(1)}M`;
  if (mc >= 1e3) return `$${(mc / 1e3).toFixed(1)}K`;
  return `$${mc.toFixed(0)}`;
}

function getProgressBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

async function sendTelegram(method, data = {}) {
  try {
    const url = `${API_BASE}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    console.error('[TelegramBot] Error:', err.message);
    return null;
  }
}

async function sendTokenAlert(token, scores, devProfile, deepseekAnalysis) {
  const riskEmoji = scores.safetyScore > 70 ? '🟢' : scores.safetyScore > 40 ? '🟡' : '🔴';
  const moonEmoji = scores.moonshotProbability > 70 ? '🚀🚀' : scores.moonshotProbability > 50 ? '🚀' : '📈';
  const prelaunchBadge = token.detected_prelaunch
    ? `\n⚡ *PRE-LAUNCH EDGE* — detected ${token.prelaunch_lead_time_seconds}s before live`
    : '';

  const message = `
━━━━━━━━━━━━━━━━━━━━
${moonEmoji} *NEW SIGNAL: $${token.symbol}*
━━━━━━━━━━━━━━━━━━━━
${prelaunchBadge}
*MC:* ${formatMC(token.current_mc)}
*Pump.fun Progress:* ${token.bonding_curve_progress || 0}% ${getProgressBar(token.bonding_curve_progress || 0)}

📊 *SCORES*
${riskEmoji} Safety: ${scores.safetyScore}/100
📣 Social: ${scores.socialScore}/100 ${scores.isExponential ? '⚡ VIRAL SURGE' : ''}
🧠 Smart Money: ${scores.smartMoneyScore}/100 (${scores.smartMoneyCount || 0} wallets)

🎯 *PROBABILITIES*
Ape In: *${scores.apeProbability}%*
Moonshot: *${scores.moonshotProbability}%*
Absolute Nuke: *${scores.absoluteMoonshotProbability || 0}%*

👨‍💻 *DEV PROFILE*
Type: ${devProfile?.label || 'unknown'}
Launches: ${devProfile?.total_launches || 0} | Rugs: ${devProfile?.rug_count || 0}
Avg Peak Return: *${(devProfile?.avg_return_at_peak || 0).toFixed(1)}x*
Rep Score: ${devProfile?.reputation_score || 0}/100

📝 *DEEPSEEK ANALYSIS*
${deepseekAnalysis?.reasoning || 'N/A'}

*CA:* \`${token.address}\`
━━━━━━━━━━━━━━━━━━━━
`;

  const buttons = {
    inline_keyboard: [
      [
        { text: '✅ Ape In', callback_data: `ape_${token.address}` },
        { text: '❌ Skip', callback_data: `skip_${token.address}` }
      ],
      [
        { text: '📊 Full Report', callback_data: `report_${token.address}` },
        { text: '👨‍💻 Dev History', callback_data: `dev_${token.address}` }
      ]
    ]
  };

  const result = await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    reply_markup: buttons
  });

  if (result?.result?.message_id) {
    pendingAlerts.set(token.address, result.result.message_id);
  }

  return result;
}

function queueScoredToken(token, result) {
  queuedAlerts.push({ token, result, time: Date.now() });
}

async function flushTopAlerts() {
  if (!queuedAlerts.length) return;

  const now = Date.now();
  const fresh = queuedAlerts.filter(a => now - a.time < 300000);
  queuedAlerts.length = 0;
  console.log(`[AlertBatcher] ${fresh.length} queued, filtering for >= ${ALERT_THRESHOLD}%...`);

  const scores = fresh.map(a => `${a.token.symbol || '?'}:${a.result.apeProbability}%`).join(', ');
  const eligible = fresh
    .filter(a => a.result.apeProbability >= ALERT_THRESHOLD)
    .sort((a, b) => b.result.apeProbability - a.result.apeProbability)
    .slice(0, MAX_ALERTS);

  console.log(`[AlertBatcher] Scores: [${scores}] → ${eligible.length} eligible`);
  if (!eligible.length) return;

  let message = `🚀 *TOP ${eligible.length} SIGNALS*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (let i = 0; i < eligible.length; i++) {
    const { token, result } = eligible[i];
    const riskEmoji = result.safety?.safetyScore > 70 ? '🟢' : result.safety?.safetyScore > 40 ? '🟡' : '🔴';
    const symbol = token.symbol || 'UNKNOWN';
    const mc = token.current_mc || 0;
    const devLabel = result.devProfile?.label || 'unknown';

    message += `*#${i + 1}* ${riskEmoji} *$${symbol}* — ${result.apeProbability}%\n`;
    message += `   MC: ${formatMC(mc)} | Safety: ${result.safety?.safetyScore || '?'} | Dev: ${devLabel}\n`;
    message += `   CA: \`${token.address}\`\n\n`;
  }

  message += `━━━━━━━━━━━━━━━━━━━━\nUse /positions and /portfolio to manage`;

  const sent = await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  });

  if (sent?.ok) {
    console.log(`[AlertBatcher] Alert sent (${eligible.length} tokens)`);
  } else {
    console.error(`[AlertBatcher] Send failed:`, sent?.description || 'unknown');
  }

  // Auto-buy top 2 tokens from this batch
  await autoBuyTopN(eligible, 2);
}

async function autoBuyTopN(eligible, n) {
  const { executeBuy, getBalance } = require('./trade-executor');
  const db = require('../database/db');

  // Safety gates
  const safe = eligible.filter(e => {
    const r = e.result;
    if (r.bundleInfo?.bundleDetected) return false;
    if (r.clusterAnalysis?.clusterRisk === 'high') return false;
    if (r.safety?.safetyScore < 40) return false;
    if (r.divergenceCheck?.divergenceScore > 50) return false;
    return true;
  });

  if (!safe.length) return;

  // Check current open positions count and total invested
  const openPositions = await db.getOpenPositions();
  const MAX_POSITIONS = 5;
  const MAX_PORTFOLIO_PCT = 0.5;
  if (openPositions.length >= MAX_POSITIONS) {
    console.log(`[AutoBuy] ${openPositions.length} positions open, skipping buy (max ${MAX_POSITIONS})`);
    return;
  }
  const totalInvested = openPositions.reduce((s, p) => s + (p.sol_invested || 0), 0);
  const bal = await getBalance();
  const availableBudget = bal * MAX_PORTFOLIO_PCT - totalInvested;
  if (availableBudget <= 0.001) {
    console.log(`[AutoBuy] Budget used (${totalInvested.toFixed(3)}/${(bal * MAX_PORTFOLIO_PCT).toFixed(3)} SOL), skipping`);
    return;
  }

  const top = safe.slice(0, n);

  for (const { token, result } of top) {
    try {
      // Confidence-based sizing: higher score = bigger allocation
      const score = result.apeProbability;
      const sizeMultiplier = score >= 90 ? 1.5 : score >= 80 ? 1.0 : 0.5;
      const maxPerTrade = config.config.maxSolPerTrade || 0.1;
      const amount = Math.min(maxPerTrade * sizeMultiplier, availableBudget / top.length);
      if (amount < 0.001) continue;

      const buyResult = await executeBuy(token.address, 'auto_signal', amount);
      if (buyResult.success) {
        // Sell target from local synthesis
        const targets = result.deepseekAnalysis?.suggested_exit_targets;
        let sellTarget;
        if (Array.isArray(targets) && targets.length) {
          sellTarget = targets.reduce((a, b) => a + b, 0) / targets.length;
        } else {
          // Fallback: map score to target
          sellTarget = 1 + score / 60; // 67% → 2.1x, 80% → 2.3x, 95% → 2.6x
        }
        const exitMultiplier = Math.max(sellTarget * 0.985, 1.6);

        const moonshotPct = result.moonshotProbability || result.deepseekAnalysis?.moonshot_probability || 0;
        await db.getDb().collection('positions').updateOne(
          { token_address: token.address, status: 'open' },
          { $set: { sell_target_multiplier: exitMultiplier, sell_target_set_at: new Date(), auto_buy_score: score, moonshot_probability: moonshotPct } }
        );

        const notifyMsg = `🤖 *AUTO-BOUGHT* $${token.symbol || ''}\n${amount.toFixed(4)} SOL | Target: ${exitMultiplier.toFixed(2)}x | Score: ${score}%`;
        await sendTelegram('sendMessage', { chat_id: CHAT_ID, text: notifyMsg, parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error(`[AutoBuy] Failed ${token.address}:`, e.message);
    }
  }
}

function startAlertBatcher() {
  setInterval(flushTopAlerts, 300000);
  console.log('[Telegram] Alert batcher started (every 5 min, top 20 >= 50%)');
}

// Handle /start command and other messages
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const text = msg.text;

  if (text === '/start') {
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '🚀 *Meme Engine Active!*\n\nI will send the top 20 tokens every 5 minutes. Top 2 auto-bought. Sell targets set from analysis.\n\nCommands:\n/portfolio - Check wallet balance\n/positions - View open positions\n/pnl - View P&L summary',
      parse_mode: 'Markdown'
    });
  }

  if (text === '/portfolio') {
    const { getBalance } = require('./trade-executor');
    const bal = await getBalance();
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `💰 *Wallet Balance*\n\n${bal.toFixed(4)} SOL`,
      parse_mode: 'Markdown'
    });
  }

  if (text === '/positions') {
    const db = require('../database/db');
    const positions = await db.getDb().collection('positions').find({ status: 'open' }).toArray();
    if (!positions.length) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: 'No open positions.' });
      return;
    }
    let msg = '📊 *Open Positions*\n\n';
    for (const p of positions) {
      const currentPrice = await require('../utils/price-feed').getCurrentPrice(p.tokenAddress);
      const pnl = p.entry_price > 0 ? ((currentPrice / p.entry_price) - 1) * 100 : 0;
      msg += `$${p.tokenAddress.slice(0, 8)}... Entry: $${p.entry_price?.toFixed(6)} | Now: $${currentPrice?.toFixed(6)} | P&L: ${pnl.toFixed(1)}%\n`;
    }
    await sendTelegram('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
  }

  if (text === '/pnl') {
    const { generatePortfolioSummary } = require('./pnl-card');
    const summary = await generatePortfolioSummary();
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `📈 *P&L Summary*\n\nTotal Trades: ${summary.totalTrades}\nWins: ${summary.wins}\nLosses: ${summary.losses}\nTotal P&L: ${summary.totalPnL?.toFixed(4)} SOL`,
      parse_mode: 'Markdown'
    });
  }
}

async function sendTradeNotification(token, type, amount, pnl = null) {
  const emoji = type === 'buy' ? '✅' : '💰';
  const title = type === 'buy' ? 'Bought' : 'Sold';
  let msg = `${emoji} *${title}: $${token.symbol || 'UNKNOWN'}*\n\n`;
  msg += `Amount: ${amount.toFixed(4)} SOL\n`;
  msg += `Price: $${token.price?.toFixed(6)}\n`;
  if (pnl !== null) {
    msg += `P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}% (${pnl > 0 ? '🚀' : '📉'})\n`;
  }
  msg += `\n*CA:* \`${token.address}\``;

  await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: msg,
    parse_mode: 'Markdown'
  });
}

module.exports = { sendTokenAlert, queueScoredToken, flushTopAlerts, startAlertBatcher, handleUpdate, sendTradeNotification };
