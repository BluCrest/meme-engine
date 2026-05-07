const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const db = require('../database/db');
const fetch = require('node-fetch');

// Initialize without polling/webhook - server.js will handle webhook via express
const bot = new TelegramBot(config.telegram.botToken, { polling: false, webHook: false });

// Set webhook via Telegram API directly (no separate server needed)
async function setupWebhook() {
  if (process.env.RENDER === 'true' && process.env.RENDER_EXTERNAL_URL) {
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/setWebhook?url=${process.env.RENDER_EXTERNAL_URL}/bot${config.telegram.botToken}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.ok) {
        console.log('[TelegramBot] Webhook set successfully');
      } else {
        console.error('[TelegramBot] Webhook failed:', data.description);
      }
    } catch (err) {
      console.error('[TelegramBot] Webhook error:', err.message);
    }
  }
}

setupWebhook();

const CHAT_ID = config.telegram.chatId;
const pendingAlerts = new Map();

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
Absolute Nuke: *${scores.absoluteMoonshotProbability || 0}%

👨‍💻 *DEV PROFILE*
Type: ${devProfile?.label || 'unknown'}
Launches: ${devProfile?.total_launches || 0} | Rugs: ${devProfile?.rug_count || 0}
Avg Peak Return: *${(devProfile?.avg_return_at_peak || 0).toFixed(1)}x*
Rep Score: ${devProfile?.reputation_score || 0}/100
${devProfile?.cross_chain_flag ? `⛓️ Cross-chain rugs: ${devProfile.cross_chain_rugs || 0}` : ''}

⚠️ *RED FLAGS*
${deepseekAnalysis?.redFlags?.map(f => `• ${f}`).join('\n') || '• None detected'}

✅ *KEY SIGNALS*
${deepseekAnalysis?.keySignals?.map(s => `• ${s}`).join('\n') || '• None'}

🤖 *AI REASONING*
${deepseekAnalysis?.reasoning || 'N/A'}

*Confidence:* ${deepseekAnalysis?.confidence || 0}%

━━━━━━━━━━━━━━━━━━━━
*Suggested Entry:* ${formatMC(deepseekAnalysis?.suggestedEntryMC)}
*Exit Targets:* ${deepseekAnalysis?.suggestedExitTargets?.join(' → ') || 'N/A'}
━━━━━━━━━━━━━━━━━━━━
`;

  pendingAlerts.set(token.address, {
    token,
    scores,
    timeout: setTimeout(() => autoExecute(token.address), 10000)
  });

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ APE IN', callback_data: `ape_${token.address}` },
      { text: '👀 WATCHLIST', callback_data: `watch_${token.address}` },
      { text: '❌ SKIP', callback_data: `skip_${token.address}` }
    ], [
      { text: '📊 FULL REPORT', callback_data: `report_${token.address}` },
      { text: '🔍 DEV HISTORY', callback_data: `dev_${token.address}` }
    ]]
  };

  await bot.sendMessage(CHAT_ID, message, {
    parse_mode: 'Markdown',
    reply_markup: keyboard
  });
}

async function autoExecute(tokenAddress) {
  const pending = pendingAlerts.get(tokenAddress);
  if (!pending) return;

  const token = await db.getToken(tokenAddress);
  if (token?.ape_probability >= config.config.autoExecuteProbability) {
    // TODO: executeBuy(tokenAddress, 'auto_timeout');
    await bot.sendMessage(CHAT_ID, `🤖 *AUTO-BOUGHT* $${token.symbol} — no response in 10s`, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(CHAT_ID, `⏰ *Alert expired* — $${token?.symbol} not auto-bought (prob < ${config.config.autoExecuteProbability}%)`, { parse_mode: 'Markdown' });
  }
  pendingAlerts.delete(tokenAddress);
}

// Callback handlers
bot.on('callback_query', async (query) => {
  const [action, address] = query.data.split('_');
  const pending = pendingAlerts.get(address);

  if (pending) clearTimeout(pending.timeout);

  switch(action) {
    case 'ape':
      // TODO: await executeBuy(address, 'manual_confirm');
      await bot.answerCallbackQuery(query.id, { text: '✅ Buying...' });
      break;
    case 'watch':
      await db.upsertToken({ address, status: 'watchlist' });
      await bot.answerCallbackQuery(query.id, { text: '👀 Added to watchlist' });
      break;
    case 'skip':
      await db.upsertToken({ address, status: 'passed' });
      await bot.answerCallbackQuery(query.id, { text: '❌ Skipped' });
      break;
    case 'report':
      // TODO: await sendFullReport(query.message.chat.id, address);
      break;
    case 'dev':
      // TODO: await sendDevHistory(query.message.chat.id, address);
      break;
  }
  pendingAlerts.delete(address);
});

module.exports = { sendTokenAlert, bot };