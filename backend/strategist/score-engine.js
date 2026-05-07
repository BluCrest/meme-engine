const { runSafetyCheck } = require('../sentinel/safety-checker');
const { computeViralityVelocity } = require('../detective/virality-scorer');
const { getSmartMoneyScore } = require('../profiler/smart-money');
const { buildDevProfile } = require('../profiler/dev-fingerprint');
const { analyzeWalletClusters } = require('../sentinel/wallet-cluster');
const { detectBundles } = require('../sentinel/bundle-detector');
const { getBondingCurveProgress } = require('./graduation-tracker');
const { checkMomentumDivergence } = require('../detective/momentum-divergence');
const { findMatchingPatterns } = require('./pattern-matcher');
const { getMultiSourceVolume } = require('../utils/multi-volume');
const db = require('../database/db');

async function getDevWallet(tokenAddress) {
  const token = await db.getToken(tokenAddress);
  return token?.dev_wallet || null;
}

async function computeFinalScore(tokenAddress) {
  try {
    if (tokenAddress.startsWith('0x') || tokenAddress.length < 32 || tokenAddress.length > 44) {
      return { status: 'disqualified', reason: 'not_solana', apeProbability: 0, shouldAlert: false };
    }
    const token = await db.getToken(tokenAddress);
    const symbol = token?.symbol || 'UNKNOWN';

    // Enrich volume data from multiple sources (DexPaprika, GMGN, DexScreener)
    const multiVol = await getMultiSourceVolume(tokenAddress, token?.volume_24h || 0);
    if (multiVol.volume_sources > 1) {
      await db.upsertToken({ address: tokenAddress, volume_24h: multiVol.volume_24h, multi_volume: multiVol });
    }

    // Serialize checks to avoid RPC rate limits (was Promise.all — 20+ parallel calls)
    const safety = await runSafetyCheck(tokenAddress);
    await sleep(250);
    const social = await computeViralityVelocity(tokenAddress, symbol);
    await sleep(250);
    const smartMoney = await getSmartMoneyScore(tokenAddress);
    await sleep(250);
    const devWallet = await getDevWallet(tokenAddress);
    await sleep(250);
    const clusterAnalysis = await analyzeWalletClusters(tokenAddress);
    await sleep(250);
    const bundleInfo = await detectBundles(tokenAddress, null);
    await sleep(250);
    const graduationInfo = await getBondingCurveProgress(tokenAddress);
    await sleep(250);
    const divergenceCheck = await checkMomentumDivergence(tokenAddress);

    const devProfile = devWallet ? await buildDevProfile(devWallet) : null;

    // Hard disqualifiers
    if (safety.honeypot) return { status: 'disqualified', reason: 'honeypot', apeProbability: 0, shouldAlert: false, safety };
    if (safety.top5Concentration > 80) return { status: 'disqualified', reason: 'top5_hold_>80%', apeProbability: 0, shouldAlert: false };
    if (clusterAnalysis.clusterRisk === 'high' && bundleInfo.bundleDetected) {
      return { status: 'disqualified', reason: 'bundled_cluster', apeProbability: 0, shouldAlert: false };
    }
    if (divergenceCheck.divergenceScore > 75) {
      return { status: 'disqualified', reason: 'momentum_divergence', apeProbability: 0, shouldAlert: false };
    }
    if (devProfile?.label === 'serial_rugger') {
      return { status: 'disqualified', reason: 'serial_rugger', apeProbability: 0, shouldAlert: false };
    }
    if (devProfile && devProfile.rug_count >= 3) {
      return { status: 'disqualified', reason: 'rug_count_3+', apeProbability: 0, shouldAlert: false };
    }

    const devModifier = devProfile ? devProfile.reputation_score / 100 : 0.5;

    const gradBonus =
      graduationInfo.graduationSignal === 'graduating_now' ? 20 :
      graduationInfo.graduationSignal === 'close_to_grad' ? 10 : 0;

    const vol = token?.volume_24h || 0;
    const volBonus = vol >= 50000 ? 15 : vol >= 10000 ? 10 : vol >= 5000 ? 5 : vol >= 500 ? 2 : -10;
    const multiSourceBonus = (token?.multi_volume?.volume_sources || 1) >= 2 ? 5 : 0;

    // Redistribute social weight when X/DeepSeek unavailable (social=0)
    const socialAvailable = social.socialScore > 0;
    const safetyWeight = socialAvailable ? 0.35 : 0.50;
    const smartWeight = socialAvailable ? 0.25 : 0.35;
    let apeProbability = Math.min(100,
      safety.safetyScore * safetyWeight +
      social.socialScore * 0.25 +
      smartMoney.smartMoneyScore * smartWeight +
      devModifier * 15 +
      gradBonus +
      volBonus +
      multiSourceBonus
    );

    if (bundleInfo.bundleDetected) apeProbability *= 0.6;

    let moonshotProbability = 0;
    if (social.isExponential && smartMoney.smartMoneyCount >= 3) {
      moonshotProbability = Math.min(100, social.socialScore * 0.5 + smartMoney.smartMoneyScore * 0.5);
    }

    // Pattern matching
    const patternMatches = await findMatchingPatterns({
      safety, social, smartMoney, devProfile, clusterAnalysis, bundleInfo
    });

    // Local synthesis (no DeepSeek API needed)
    const finalApeProbability = Math.round(apeProbability);
    const tokenAge = token?.age_min || 999;
    const analysis = synthesizeAnalysis({
      safety, social, smartMoney, devProfile, bundleInfo, clusterAnalysis,
      divergenceCheck, graduationInfo, tokenAge,
      apeProbability: finalApeProbability,
      moonshotProbability: Math.round(moonshotProbability)
    });

    const result = {
      apeProbability: finalApeProbability,
      moonshotProbability: analysis.moonshot_probability || 0,
      absoluteMoonshotProbability: analysis.absolute_moonshot_probability || 0,
      shouldAlert: finalApeProbability >= 55,
      deepseekAnalysis: analysis,
      safety,
      social,
      smartMoney,
      devProfile,
      graduationInfo,
      bundleInfo,
      divergenceCheck,
      clusterAnalysis,
      patternMatches
    };

    // Save to DB
    await db.upsertToken({
      address: tokenAddress,
      ape_probability: result.apeProbability,
      moonshot_probability: result.moonshotProbability,
      absolute_moonshot_probability: result.absoluteMoonshotProbability
    });

    return result;

  } catch (err) {
    console.error('[ScoreEngine] Error:', err.message);
    throw err;
  }
}

// Local synthesis engine — replaces DeepSeek when unavailable
function synthesizeAnalysis(data) {
  const { safety, social, smartMoney, devProfile, bundleInfo, clusterAnalysis, divergenceCheck, graduationInfo, tokenAge } = data;
  const signals = [];
  const redFlags = [];
  const isFresh = (tokenAge || 999) < 2;

  if (safety.safetyScore > 70) signals.push(`High safety score (${safety.safetyScore})`);
  else if (safety.safetyScore < 40) redFlags.push(`Low safety score (${safety.safetyScore})`);
  if (safety.ownershipRenounced) signals.push('Ownership renounced');
  if (safety.liquidityLocked) signals.push(`Liquidity locked ${safety.liquidityLockDuration}h`);
  if (safety.honeypot) redFlags.push('Honeypot detected');
  if (safety.top5Concentration > 50) redFlags.push(`Top5 hold ${safety.top5Concentration.toFixed(0)}%`);

  if (smartMoney.smartMoneyCount >= 3) signals.push(`${smartMoney.smartMoneyCount} smart money wallets`);
  if (smartMoney.smartMoneyScore > 60) signals.push(`Smart money confidence ${smartMoney.smartMoneyScore}`);

  if (bundleInfo?.bundleDetected) redFlags.push('Bundle detected');
  if (clusterAnalysis?.clusterRisk === 'high') redFlags.push('High cluster risk');

  if (divergenceCheck?.divergenceScore > 50) redFlags.push(`Divergence ${divergenceCheck.divergenceScore}`);
  if (graduationInfo?.graduationSignal === 'graduating_now') signals.push('Graduating now');

  if (devProfile) {
    if (devProfile.label === 'serial_rugger') redFlags.push('Serial rugger');
    else if (devProfile.label === 'first_time') signals.push('First-time dev');
    if (devProfile.rug_count > 0) redFlags.push(`${devProfile.rug_count} prior rugs`);
    if (devProfile.reputation_score > 70) signals.push(`Dev reputation ${devProfile.reputation_score}`);
  }

  // Fresh token flag
  if (isFresh) signals.push(`Fresh ${tokenAge.toFixed(1)}m old`);

  // Compute target from signals + age
  let targetMultiplier = isFresh ? 1.3 : 2.0;
  const positiveSignals = signals.length;
  const negativeFlags = redFlags.length;
  if (positiveSignals >= 4) targetMultiplier = Math.max(targetMultiplier, 3.0);
  else if (positiveSignals >= 3) targetMultiplier = Math.max(targetMultiplier, 2.0);
  if (negativeFlags > 0) targetMultiplier = Math.max(targetMultiplier * (1 - negativeFlags * 0.15), isFresh ? 1.1 : 1.6);
  if (isFresh) targetMultiplier = Math.min(targetMultiplier, 2.5); // cap fresh tokens at 2.5x

  const reasoning = signals.length
    ? `Synthesis: ${signals.join(', ')}${redFlags.length ? '. Risks: ' + redFlags.join(', ') : ''}`
    : 'Synthesis: Limited positive signals, proceed with caution';

  return {
    ape_probability: data.apeProbability,
    moonshot_probability: data.moonshotProbability,
    absolute_moonshot_probability: 0,
    risk_level: negativeFlags > 2 ? 'high' : negativeFlags > 0 ? 'medium' : isFresh ? 'medium' : 'low',
    key_signals: signals,
    red_flags: redFlags,
    suggested_entry_mc: null,
    suggested_exit_targets: [targetMultiplier],
    reasoning,
    confidence: Math.max(10, 70 - negativeFlags * 15 + positiveSignals * 5),
    pattern_match: null,
    secondary_signals: []
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { computeFinalScore };
