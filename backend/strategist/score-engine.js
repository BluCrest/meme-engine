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
const { checkVitality } = require('../utils/token-vitality');
const patternMemory = require('../agents/pattern-memory');
const adaptiveWeights = require('../agents/adaptive-weights');
const { computeConviction } = require('../agents/signal-confidence');
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

    // Batch RPC calls to avoid rate limits while maximizing parallelism
    // Batch 1: safety (RPC-heavy) + social (DexScreener, no RPC) + devWallet (DB, no RPC)
    const [safety, social, devWallet] = await Promise.all([
      runSafetyCheck(tokenAddress),
      computeViralityVelocity(tokenAddress, symbol),
      getDevWallet(tokenAddress)
    ]);
    await sleep(300);

    // Batch 2: smartMoney (RPC: holders) + clusterAnalysis (RPC)
    const [smartMoney, clusterAnalysis] = await Promise.all([
      getSmartMoneyScore(tokenAddress),
      analyzeWalletClusters(tokenAddress)
    ]);
    await sleep(300);

    // Batch 3: bundleInfo (RPC) + graduationInfo/velocity (RPC) + divergence (DexScreener + RPC)
    const [bundleInfo, graduationInfo, divergenceCheck] = await Promise.all([
      detectBundles(tokenAddress, null),
      getBondingCurveProgress(tokenAddress),
      checkMomentumDivergence(tokenAddress)
    ]);

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

    // Token vitality: skip if dead (no recent buys, volume dried, all sells)
    const tokenVitality = await checkVitality(tokenAddress, null);
    if (tokenVitality.isDead) {
      return { status: 'disqualified', reason: 'token_dead: ' + tokenVitality.reasons.join(', '), apeProbability: 0, shouldAlert: false, vitality: tokenVitality };
    }

    const devScore = devProfile ? devProfile.reputation_score : 50;

    const socialAvailable = social.socialScore > 0;
    const devWeight = socialAvailable ? 0.20 : 0.25;
    const safetyWeight = socialAvailable ? 0.25 : 0.30;
    const smartWeight = socialAvailable ? 0.15 : 0.20;
    const socialWeight = socialAvailable ? 0.15 : 0;

    let apeProbability = Math.min(100,
      safety.safetyScore * safetyWeight +
      social.socialScore * socialWeight +
      smartMoney.smartMoneyScore * smartWeight +
      devScore * devWeight +
      gradBonus +
      mcBonus +
      freshnessBonus +
      volMcBonus +
      multiSourceBonus +
      smConfidenceBonus +
      velocityBonus
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

    // Agent: pattern memory — historical bonus from similar past tokens
    const historicalBonus = patternMemory.getHistoricalBonus({ mc, age_min: tokenAge });
    if (historicalBonus !== 0) {
      apeProbability = Math.min(100, apeProbability + historicalBonus);
    }

    // Agent: adaptive weights — learn from trade outcomes
    const currentWeights = await adaptiveWeights.adjustWeights();

    // Agent: signal confidence — conviction scoring
    const conviction = computeConviction({
      safety, smartMoney, vitality: tokenVitality, social,
      apeProbability: Math.round(apeProbability),
      tokenAge
    });

    // Record this evaluation for future learning
    await patternMemory.recordEvaluation(
      tokenAddress,
      { mc, age_min: tokenAge, volume: vol, safetyScore: safety.safetyScore, smartMoneyScore: smartMoney.smartMoneyScore },
      Math.round(apeProbability),
      false,
      null
    );

    // Local synthesis (no DeepSeek API needed)
    const finalApeProbability = Math.round(apeProbability);
    const vitality = tokenVitality;
    const analysis = synthesizeAnalysis({
      safety, social, smartMoney, devProfile, bundleInfo, clusterAnalysis,
      divergenceCheck, graduationInfo, tokenAge, vitality, conviction,
      apeProbability: finalApeProbability,
      moonshotProbability: Math.round(moonshotProbability)
    });

    // Fallback: if RPC rate-limited and score is near 0, use volume-only scoring
    if (finalApeProbability < 15 && token?.volume_24h > 1000) {
      const volScore = Math.min(60, Math.round((token.volume_24h / 500) * 5));
      const mcScore = token.current_mc < 9000 ? 20 : 0;
      const fallbackScore = Math.max(finalApeProbability, volScore + mcScore);
      console.log(`[ScoreEngine] ${symbol}: RPC score ${finalApeProbability}%, volume fallback -> ${fallbackScore}%`);
      apeProbability = fallbackScore;
    }

    const result = {
      apeProbability: Math.round(apeProbability),
      moonshotProbability: analysis.moonshot_probability || 0,
      absoluteMoonshotProbability: analysis.absolute_moonshot_probability || 0,
      shouldAlert: finalApeProbability >= 65,
      deepseekAnalysis: analysis,
      conviction,
      vitality,
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
  const { safety, social, smartMoney, devProfile, bundleInfo, clusterAnalysis, divergenceCheck, graduationInfo, tokenAge, vitality, conviction } = data;
  const signals = [];
  const redFlags = [];
  const isFresh = (tokenAge || 999) < 2;

  if (safety.safetyScore > 70) signals.push(`High safety score (${safety.safetyScore})`);
  else if (safety.safetyScore < 40) redFlags.push(`Low safety score (${safety.safetyScore})`);
  if (safety.ownershipRenounced) signals.push('Ownership renounced');
  if (safety.liquidityLocked) signals.push(`Liquidity locked ${safety.liquidityLockDuration}h`);
  if (safety.honeypot) redFlags.push('Honeypot detected');
  if (safety.top5Concentration > 50) redFlags.push(`Top5 hold ${safety.top5Concentration.toFixed(0)}%`);

  // Vitality signals
  if (vitality) {
    if (vitality.isAlive) signals.push(`Token active: ${vitality.signals.join(', ')}`);
    if (vitality.isDead) redFlags.push(`Token dead: ${vitality.reasons.join(', ')}`);
    if (vitality.momentum === 'active') signals.push(`Momentum: active`);
    if (vitality.recentTxns > 0) signals.push(`${vitality.recentTxns} txns in 1h`);
    if (vitality.buySellRatio > 0.5) signals.push(`${(vitality.buySellRatio * 100).toFixed(0)}% buys`);
    else if (vitality.buySellRatio < 0.35) redFlags.push(`Only ${(vitality.buySellRatio * 100).toFixed(0)}% buys`);
  }

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

  // Conviction
  if (conviction) {
    signals.push(`Conviction: ${conviction.label} (${conviction.signalCount}/5 signals)`);
    if (conviction.contradictions.length) {
      redFlags.push(`Contradictions: ${conviction.contradictions.join(', ')}`);
    }
  }

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
