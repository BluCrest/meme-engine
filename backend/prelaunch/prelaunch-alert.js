const config = require('../config');
const db = require('../database/db');

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

async function sendPreLaunchAlert({ message, potentialWallets, symbol, name, chatId }) {
  const devProfile = potentialWallets.length > 0
    ? await db.getDevProfile(potentialWallets[0])
    : null;

  const devSummary = devProfile
    ? `👨‍💻 Dev: *${devProfile.label}* | ${devProfile.rug_count} rugs / ${devProfile.total_launches || 0} launches | Rep: ${devProfile.reputation_score || 0}/100`
    : '👨‍💻 Dev: *Unknown wallet* — profile being built...';

  const rugWarning = devProfile?.label === 'serial_rugger'
    ? '\n🚨 *SERIAL RUGGER — HIGH RISK*'
    : '';

  const msg = `
⚡ *PRE-LAUNCH DETECTED*
━━━━━━━━━━━━━━━━━━━━
Token: *${symbol ? `$` + symbol + '`' : 'Unknown'} ${name ? `(${name})` : ''}
Stage: *NOT LIVE YET*
${devSummary}${rugWarning}

📩 *Source message:*
_${escapeMarkdown(message.substring(0, 300))}_

⏳ Monitoring for launch...
━━━━━━━━━━━━━━━━━━━━
`;

  try {
    const token = config.telegram.botToken;
    const chatId = config.telegram.chatId;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'MarkdownV2' })
    });
    console.log(`[PreLaunch] Alert sent for ${symbol || 'unknown token'}`);
  } catch (err) {
    console.error('[PreLaunch] Alert failed:', err.message);
  }
}

// Called when token goes live — links prelaunch detection to live token
async function linkPrelaunchToLive(tokenAddress, devWallet) {
  await db.getDb().collection('prelaunch_detections').updateOne(
    { dev_wallet: devWallet, went_live_at: null },
    {
      $set: {
        token_address: tokenAddress,
        went_live_at: new Date(),
        lead_time_seconds: Math.round((Date.now() - new Date().getTime()) / 1000) // TODO: calculate actual lead time
      }
    },
    { sort: { detected_at: -1 } }
  );

  // Update token record
  await db.upsertToken({
    address: tokenAddress,
    detected_prelaunch: true,
    prelaunch_lead_time_seconds: 0 // TODO: calculate from prelaunch detection
  });
}

module.exports = { sendPreLaunchAlert, linkPrelaunchToLive };