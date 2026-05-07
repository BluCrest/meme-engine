const { buildDevProfile } = require('../profiler/dev-fingerprint');
const { checkCrossChainHistory } = require('../profiler/cross-chain-tracker');
const db = require('../database/db');
const config = require('../config');

async function preloadDevProfile(devWallet) {
  console.log(`[PreSeed] Pre-loading dev profile for ${devWallet}`);

  // Check if we already have a recent profile
  const existing = await db.getDevProfile(devWallet);
  if (existing && existing.updated_at) {
    const ageMinutes = (Date.now() - new Date(existing.updated_at).getTime()) / 60000;
    if (ageMinutes < 60) {
      console.log(`[PreSeed] Profile already fresh for ${devWallet}`);
      return existing;
    }
  }

  // Build full profile
  const profile = await buildDevProfile(devWallet);

  // Cross-chain check while we're at it
  if (profile) {
    try {
      const crossChainData = await checkCrossChainHistory(devWallet);
      if (crossChainData.crossChainRugs > 0) {
        profile.cross_chain_rugs = crossChainData.crossChainRugs;
        profile.cross_chain_flag = true;

        const { bot } = require('../operator/telegram-bot');
        await bot.sendMessage(
          config.telegram.chatId,
          `🚨 *CROSS-CHAIN RUGGER* — Dev ${devWallet.slice(0,8)}... has ${crossChainData.crossChainRugs} rugs on other chains`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      console.error('[PreSeed] Cross-chain check failed:', err.message);
    }
  }

  console.log(`[PreSeed] Profile ready: ${profile?.label} | ${profile?.rug_count} rugs | Rep: ${profile?.reputation_score}`);
  return profile;
}

module.exports = { preloadDevProfile };