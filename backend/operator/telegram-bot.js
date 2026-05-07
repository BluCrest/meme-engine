const config = require('../config');
const db = require('../database/db');

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

module.exports = { sendTokenAlert };
