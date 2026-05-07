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
    if (tokenAddress.startsWith('0x') || tokenAddress.length < 32 || tokenAddress.length > 44) {
      return { status: 'disqualified', reason: 'not_solana', apeProbability: 0, shouldAlert: false };
    }
    const token = await db.getToken(tokenAddress);
    const symbol = token?.symbol || 'UNKNOWN';

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

    // Redistribute social weight when X/DeepSeek unavailable (social=0)
    const socialAvailable = social.socialScore > 0;
    const safetyWeight = socialAvailable ? 0.35 : 0.50;
    const smartWeight = socialAvailable ? 0.25 : 0.35;
    let apeProbability = Math.min(100,
      safety.safetyScore * safetyWeight +
      social.socialScore * 0.25 +
      smartMoney.smartMoneyScore * smartWeight +
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

    const deepseekValid = deepseekResult.confidence > 0 || deepseekResult.ape_probability > 0;
    const finalApeProbability = deepseekValid
      ? Math.round(apeProbability * 0.6 + deepseekResult.ape_probability * 0.4)
      : Math.round(apeProbability);

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { computeFinalScore };
