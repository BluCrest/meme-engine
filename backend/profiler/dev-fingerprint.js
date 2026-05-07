const db = require('../database/db');

function isRecentlyUpdated(profile, minutes = 60) {
  if (!profile?.updated_at) return false;
  const lastUpdate = new Date(profile.updated_at).getTime();
  return (Date.now() - lastUpdate) < minutes * 60 * 1000;
}

async function getAllTokensCreatedBy(devWallet) {
  try {
    // Use Helius RPC to find tokens created by this dev
    const res = await fetch(config.helius.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAssetsByAuthority',
        params: {
          authorityAddress: devWallet,
          page: 1,
          limit: 100
        }
      })
    });

    const data = await res.json();
    const tokens = data.result?.items || [];

    return tokens.map(t => ({
      address: t.id,
      symbol: t.content?.metadata?.symbol || 'UNKNOWN',
      createdAt: new Date(t.interface?.created_at || Date.now())
    }));
  } catch (err) {
    console.error('[DevFinger] Error fetching tokens:', err.message);
    return [];
  }
}

async function getPriceHistory(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return [];

    // Return simplified price history from DexScreener
    // In production, you'd want to store snapshots over time
    return [{
      mc: pair.fdv || 0,
      price: pair.priceUsd || 0,
      timestamp: Date.now()
    }];
  } catch (err) {
    console.error('[DevFinger] Price history error:', err.message);
    return [];
  }
}

function detectRugPattern(priceHistory) {
  if (!priceHistory.length) return false;
  const peak = Math.max(...priceHistory.map(p => p.mc || 0));
  const last = priceHistory[priceHistory.length - 1]?.mc || 0;
  return last < peak * 0.1; // 90%+ drop = rug
}

function getTimeToRug(priceHistory) {
  const peakIdx = priceHistory.reduce((maxIdx, p, i, arr) =>
    (p.mc || 0) > (arr[maxIdx]?.mc || 0) ? i : maxIdx, 0);
  return peakIdx * 60 / 60; // placeholder: assumes 1 data point per minute
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function buildDevProfile(devWallet) {
  let profile = await db.getDevProfile(devWallet);
  if (profile && isRecentlyUpdated(profile)) return profile;

  const launches = await getAllTokensCreatedBy(devWallet);

  const launchData = await Promise.all(
    launches.map(async (token) => {
      const priceHistory = await getPriceHistory(token.address);
      const peakMC = Math.max(...priceHistory.map(p => p.mc || 0));
      const rugged = detectRugPattern(priceHistory);
      const timeToRug = rugged ? getTimeToRug(priceHistory) : null;

      return {
        tokenAddress: token.address,
        symbol: token.symbol,
        launchedAt: token.createdAt,
        peakMC,
        rugged,
        timeToRugHours: timeToRug,
        peakReturn: token.launchMC ? peakMC / token.launchMC : 0
      };
    })
  );

  const rugRate = launchData.length
    ? launchData.filter(l => l.rugged).length / launchData.length
    : 0;
  const avgPeakReturn = average(launchData.map(l => l.peakReturn));
  const avgTimeToRug = average(launchData.filter(l => l.rugged).map(l => l.timeToRugHours));

  let reputationScore = 100;
  reputationScore -= rugRate * 60;
  reputationScore += Math.min(20, avgPeakReturn * 2);

  const label =
    rugRate > 0.7 ? 'serial_rugger' :
    rugRate > 0.4 ? 'risky_dev' :
    launchData.length <= 1 ? 'first_time' : 'mid_dev';

  profile = {
    walletAddress: devWallet,
    totalLaunches: launchData.length,
    rugCount: launchData.filter(l => l.rugged).length,
    avgPeakMC: average(launchData.map(l => l.peakMC)),
    avg_return_at_peak: avgPeakReturn,
    avg_time_to_rug_hours: avgTimeToRug,
    reputation_score: Math.max(0, Math.round(reputationScore)),
    label
  };

  await db.upsertDevProfile(profile, launchData);
  return profile;
}

module.exports = { buildDevProfile, isRecentlyUpdated };