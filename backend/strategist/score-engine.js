const { runSafetyCheck } = require('../sentinel/safety-checker');
const { computeViralityVelocity } = require('../detective/virality-scorer');
const { getSmartMoneyScore } = require('../profiler/smart-money');
const { buildDevProfile } = require('../profiler/dev-fingerprint');
const { analyzeWalletClusters } = require('../sentinel/wallet-cluster');
const { detectBundles } = require('../sentinel/bundle-detector');
const { getBondingCurveProgress } = require('./graduation-tracker');
const { checkMomentumDivergence } = require('../detective/momentum-divergence');
const { analyzeTokenRealTime, findMatchingPatterns } = require('./deepseek-analyzer');
const db = require('../database/db');

async function getDevWallet(tokenAddress) {
  const token = await db.getToken(tokenAddress);
  return token?.dev_wallet || null;
}

async function computeFinalScore(tokenAddress) {
  try {
    const token = await db.getToken(tokenAddress);
    const symbol = token?.symbol || 'UNKNOWN';

    const [
      safety,
      social,
      smartMoney,
      devWallet,
      clusterAnalysis,
      bundleInfo,
      graduationInfo,
      divergenceCheck
    ] = await Promise.all([
      runSafetyCheck(tokenAddress),
      computeViralityVelocity(tokenAddress, symbol),
      getSmartMoneyScore(tokenAddress),
      getDevWallet(tokenAddress),
      analyzeWalletClusters(tokenAddress),
      detectBundles(tokenAddress, null),
      getBondingCurveProgress(tokenAddress),
      checkMomentumDivergence(tokenAddress)
    ]);

    const devProfile = devWallet ? await buildDevProfile(devWallet) : null;

    // Hard disqualifiers
    if (safety.honeypot) return { status: 'disqualified', reason: 'honeypot', scores: { safety, social, smartMoney } };
    if (clusterAnalysis.clusterRisk === 'high' && bundleInfo.bundleDetected) {
      return { status: 'disqualified', reason: 'bundled_cluster', scores: { safety, social, smartMoney, clusterAnalysis, bundleInfo } };
    }
    if (divergenceCheck.divergenceScore > 75) {
      return { status: 'disqualified', reason: 'momentum_divergence', scores: { safety, social, smartMoney, divergenceCheck } };
    }

    const devModifier = devProfile ? devProfile.reputation_score / 100 : 0.5;

    const gradBonus =
      graduationInfo.graduationSignal === 'graduating_now' ? 20 :
      graduationInfo.graduationSignal === 'close_to_grad' ? 10 : 0;

    let apeProbability = Math.min(100,
      safety.safetyScore * 0.35 +
      social.socialScore * 0.25 +
      smartMoney.smartMoneyScore * 0.25 +
      devModifier * 15 +
      gradBonus
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

    // DeepSeek real-time analysis
    const deepseekResult = await analyzeTokenRealTime({
      tokenAddress,
      safety,
      social,
      smartMoney,
      devProfile,
      clusterAnalysis,
      bundleInfo,
      graduationInfo,
      divergenceCheck,
      apeProbability: Math.round(apeProbability),
      moonshotProbability: Math.round(moonshotProbability)
    });

    const finalApeProbability = Math.round(
      apeProbability * 0.6 + deepseekResult.ape_probability * 0.4
    );

    const result = {
      apeProbability: finalApeProbability,
      moonshotProbability: deepseekResult.moonshot_probability || 0,
      absoluteMoonshotProbability: deepseekResult.absolute_moonshot_probability || 0,
      shouldAlert: finalApeProbability >= 55,
      deepseekAnalysis: deepseekResult,
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

module.exports = { computeFinalScore };
