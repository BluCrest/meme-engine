const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const config = require('../config');
const { preloadDevProfile } = require('./dev-preseeder');
const { sendPreLaunchAlert } = require('./prelaunch-alert');
const db = require('../database/db');

let client;

// Groups to monitor — update as you find more active launch groups
// Use chat IDs (numbers) instead of usernames to avoid resolution errors
// Get chat IDs by running: node -e "console.log(event.message?.peerId?.channelId)"
const MONITORED_GROUPS = [
  // Add chat IDs here after joining the groups
  // Example: -1001234567890
];

// Patterns that suggest an imminent Pump.fun launch
const LAUNCH_PATTERNS = [
  /launching (in|on) (pump\.?fun|pf)/i,
  /pump\.?fun launch/i,
  /going live (in|on) pump/i,
  /ca dropping/i,
  /dev wallet:\s*([A-Za-z0-9]{32,44})/i,
  /deploying (in|now|soon)/i,
  /pre.?launch/i,
  /\$([A-Z]{2,10})\s*(launch|live|ca)/i
];

function isValidSolanaAddress(str) {
  return /^[A-Za-z0-9]{32,44}$/.test(str);
}

async function startPreLaunchMonitor() {
  client = new TelegramClient(
    new StringSession(config.telegram.sessionString),
    parseInt(config.telegram.apiId),
    config.telegram.apiHash,
    { connectionRetries: 5 }
  );

  await client.connect();
  console.log('[PreLaunch] Connected to Telegram, monitoring groups...');

  // Import event handler dynamically
  const { NewMessage } = require('telegram/events');

  client.addEventHandler(async (event) => {
    try {
      const message = event.message?.message;
      const chatId = event.message?.peerId?.channelId;

      if (!message) return;

      // Check if message matches any launch pattern
      const isLaunchSignal = LAUNCH_PATTERNS.some(pattern => pattern.test(message));
      if (!isLaunchSignal) return;

      console.log(`[PreLaunch] Launch signal detected in group ${chatId}`);

      // Try to extract dev wallet from message
      const walletMatches = message.match(/[A-Za-z0-9]{32,44}/g);
      const potentialWallets = walletMatches?.filter(w => isValidSolanaAddress(w)) || [];

      // Extract token name/symbol
      const symbolMatch = message.match(/\$([A-Z]{2,10})/);
      const nameMatch = message.match(/["']([^"']{2,30})["']/);

      // For each potential dev wallet, pre-load their profile immediately
      for (const wallet of potentialWallets) {
        await preloadDevProfile(wallet);
      }

      // Log the detection
      await db.insertPrelaunchDetection({
        dev_wallet: potentialWallets[0] || null,
        token_name: nameMatch?.[1] || null,
        token_symbol: symbolMatch?.[1] || null,
        detected_at: new Date(),
        tg_group: chatId?.toString(),
        tg_message: message.substring(0, 500),
        dev_profile_preloaded: potentialWallets.length > 0,
        token_address: null,
        went_live_at: null,
        lead_time_seconds: 0
      });

      // Send alert to your Telegram
      await sendPreLaunchAlert({
        message,
        potentialWallets,
        symbol: symbolMatch?.[1],
        name: nameMatch?.[1],
        chatId: chatId?.toString()
      });

    } catch (err) {
      console.error('[PreLaunch] Error handling message:', err.message);
    }
  }, new NewMessage({ chats: MONITORED_GROUPS }));

  console.log('[PreLaunch] Monitoring:', MONITORED_GROUPS);
}

async function stopPreLaunchMonitor() {
  if (client) {
    await client.disconnect();
    console.log('[PreLaunch] Disconnected');
  }
}

module.exports = { startPreLaunchMonitor, stopPreLaunchMonitor };