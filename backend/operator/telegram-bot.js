const config = require('../config');
const db = require('../database/db');

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ALERT_THRESHOLD = 67;
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

  const eligible = fresh
    .filter(a => a.result.apeProbability >= ALERT_THRESHOLD)
    .sort((a, b) => b.result.apeProbability - a.result.apeProbability)
    .slice(0, MAX_ALERTS);

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

  await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  });

  // Auto-buy top 2 tokens from this batch
  await autoBuyTopN(eligible, 2);
}

async function autoBuyTopN(eligible, n) {
  const { executeBuy } = require('./trade-executor');
  const top = eligible.slice(0, n);

  for (const { token, result } of top) {
    try {
      const buyResult = await executeBuy(token.address, 'auto_signal');
      if (buyResult.success) {
        // Compute sell target from deepseek suggested exits or fallback from apeProbability
        const targets = result.deepseekAnalysis?.suggested_exit_targets;
        let sellTarget;
        if (Array.isArray(targets) && targets.length) {
          sellTarget = targets.reduce((a, b) => a + b, 0) / targets.length;
        } else {
          sellTarget = 1 + result.apeProbability / 50; // e.g. 80% → 2.6x, 95% → 2.9x
        }
        // Apply 1.5% buffer below target
        const exitMultiplier = Math.max(sellTarget * 0.985, 1.01);

        // Store sell target on the position via DB
        const db = require('../database/db');
        await db.getDb().collection('positions').updateOne(
          { token_address: token.address, status: 'open' },
          { $set: { sell_target_multiplier: exitMultiplier, sell_target_set_at: new Date() } }
        );

        const notifyMsg = `🤖 *AUTO-BOUGHT* $${token.symbol || ''}\nTarget: ${exitMultiplier.toFixed(2)}x | Score: ${result.apeProbability}%`;
        await sendTelegram('sendMessage', { chat_id: CHAT_ID, text: notifyMsg, parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error(`[AutoBuy] Failed ${token.address}:`, e.message);
    }
  }
}

function startAlertBatcher() {
  setInterval(flushTopAlerts, 300000);
  console.log('[Telegram] Alert batcher started (every 5 min, top 20 >= 67%)');
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
      text: '🚀 *Meme Engine Active!*\n\nI will send the top 20 tokens scoring 67%+ every 5 minutes. Top 2 auto-bought. Sell targets set from AI analysis.\n\nCommands:\n/portfolio - Check wallet balance\n/positions - View open positions\n/pnl - View P&L summary',
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
