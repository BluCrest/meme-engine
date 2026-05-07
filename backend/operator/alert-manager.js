const config = require('../config');
const db = require('../database/db');

const recentAlerts = new Map(); // tokenAddress -> timestamp

async function shouldAlert(tokenAddress) {
  // Check cooldown
  const lastAlert = recentAlerts.get(tokenAddress);
  const cooldownMs = config.config.alertCooldownMinutes * 60 * 1000;

  if (lastAlert && (Date.now() - lastAlert) < cooldownMs) {
    console.log(`[AlertMgr] Cooldown active for ${tokenAddress}`);
    return false;
  }

  // Check if already alerted
  const token = await db.getToken(tokenAddress);
  if (token?.alert_sent) {
    console.log(`[AlertMgr] Already alerted for ${tokenAddress}`);
    return false;
  }

  return true;
}

async function markAlerted(tokenAddress) {
  recentAlerts.set(tokenAddress, Date.now());
  await db.upsertToken({ address: tokenAddress, alert_sent: true });
}

module.exports = { shouldAlert, markAlerted };