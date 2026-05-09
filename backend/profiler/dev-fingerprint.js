const db = require('../database/db');
const config = require('../config');
const { fetchPair } = require('../sources/source-rotator');

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

async function getTokenSnapshotsFromDB(tokenAddress) {
  try {
    const dbSnapshots = await db.getDb().collection('token_price_snapshots')
      .find({ token_address: tokenAddress })
      .sort({ timestamp: -1 })
      .limit(20)
      .toArray();
    return dbSnapshots.map(s => ({
      mc: s.mc || 0,
      price: s.price || 0,
      timestamp: new Date(s.timestamp).getTime()
    }));
  } catch (_) { return []; }
}

async function getPriceHistory(tokenAddress) {
  try {
    const pair = await fetchPair(tokenAddress);
    if (!pair) return [];

    const current = {
      mc: pair.fdv || 0,
      price: pair.priceUsd || 0,
      timestamp: Date.now(),
      priceChange24h: pair.priceChange?.h24 || 0
    };

    // Store snapshot for future rug detection
    try {
      await db.getDb().collection('token_price_snapshots').updateOne(
        { token_address: tokenAddress, timestamp: new Date() },
        { $set: { mc: current.mc, price: current.price, timestamp: new Date() } },
        { upsert: true }
      );
    } catch (_) {}

    // Merge with historical DB snapshots
    const dbSnapshots = await getTokenSnapshotsFromDB(tokenAddress);
    const allPoints = [...dbSnapshots, current];
    // Deduplicate by timestamp rounded to minute
    const seen = new Set();
    return allPoints.filter(p => {
      const key = Math.floor(p.timestamp / 60000);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err) {
    console.error('[DevFinger] Price history error:', err.message);
    return [];
  }
}

function detectRugPattern(priceHistory) {
  if (!priceHistory.length) return false;
  const peak = Math.max(...priceHistory.map(p => p.mc || 0));
  const last = priceHistory[priceHistory.length - 1]?.mc || 0;
  // Check for 90%+ drop from peak
  if (peak > 0 && last < peak * 0.1) return true;
  // Also check 24h price change if available
  const lastEntry = priceHistory[priceHistory.length - 1];
  if (lastEntry && lastEntry.priceChange24h < -90) return true;
  return false;
}

function getTimeToRug(priceHistory) {
  if (priceHistory.length < 2) return null;
  const peakIdx = priceHistory.reduce((maxIdx, p, i, arr) =>
    (p.mc || 0) > (arr[maxIdx]?.mc || 0) ? i : maxIdx, 0);
  const rugPoint = priceHistory[priceHistory.length - 1];
  const peakPoint = priceHistory[peakIdx];
  if (!rugPoint || !peakPoint) return null;
  return (rugPoint.timestamp - peakPoint.timestamp) / 3600000; // hours
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
      const firstMC = priceHistory.length > 0 ? priceHistory[0].mc || 0 : 0;

      return {
        tokenAddress: token.address,
        symbol: token.symbol,
        launchedAt: token.createdAt,
        peakMC,
        rugged,
        timeToRugHours: timeToRug,
        peakReturn: firstMC > 0 ? peakMC / firstMC : 0
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