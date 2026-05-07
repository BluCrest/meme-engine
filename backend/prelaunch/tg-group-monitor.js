const config = require('../config');
const { preloadDevProfile } = require('./dev-preseeder');
const { sendPreLaunchAlert } = require('./prelaunch-alert');
const db = require('../database/db');

// Use HTTP polling instead of gramJS (no port conflicts)
const BOT_TOKEN = config.telegram.botToken;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
let lastUpdateId = 0;
let isPolling = false;

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

async function sendTelegramRequest(method, data = {}) {
  try {
    const url = `${API_BASE}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    console.error('[PreLaunch] Error:', err.message);
    return null;
  }
}

async function startPreLaunchMonitor() {
  console.log('[PreLaunch] Starting HTTP polling for Telegram messages...');

  // Get chat IDs first by asking user to send a message
  console.log('[PreLaunch] Make sure bot is added to groups, then it will auto-detect messages');

  pollUpdates();
}

async function pollUpdates() {
  if (isPolling) return;
  isPolling = true;

  try {
    const data = await sendTelegramRequest('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message']
    });

    if (data?.result) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        const message = update.message?.text;
        const chatId = update.message?.chat?.id;

        if (!message) continue;

        // Check if message matches any launch pattern
        const isLaunchSignal = LAUNCH_PATTERNS.some(pattern => pattern.test(message));
        if (!isLaunchSignal) continue;

        console.log(`[PreLaunch] Launch signal detected in chat ${chatId}`);

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
      }
    }
  } catch (err) {
    console.error('[PreLaunch] Poll error:', err.message);
  }

  isPolling = false;
  // Continue polling
  setTimeout(pollUpdates, 1000);
}

async function stopPreLaunchMonitor() {
  console.log('[PreLaunch] Stopping...');
}

module.exports = { startPreLaunchMonitor, stopPreLaunchMonitor };
