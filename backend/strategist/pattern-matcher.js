const db = require('../database/db');

async function findMatchingPatterns(tokenData) {
  const patterns = await db.getDb().collection('deepseek_patterns')
    .find({}).toArray();

  const matches = [];

  for (const pattern of patterns) {
    if (!pattern.conditions) continue;

    let matchScore = 0;
    let totalChecks = 0;

    // Check safety conditions
    if (pattern.conditions.safety_score_min !== undefined) {
      totalChecks++;
      if (tokenData.safety?.safetyScore >= pattern.conditions.safety_score_min) matchScore++;
    }

    // Check social conditions
    if (pattern.conditions.social_score_min !== undefined) {
      totalChecks++;
      if (tokenData.social?.socialScore >= pattern.conditions.social_score_min) matchScore++;
    }

    // Check dev conditions
    if (pattern.conditions.dev_reputation_min !== undefined && tokenData.devProfile) {
      totalChecks++;
      if (tokenData.devProfile.reputation_score >= pattern.conditions.dev_reputation_min) matchScore++;
    }

    // Check smart money conditions
    if (pattern.conditions.smart_money_min !== undefined) {
      totalChecks++;
      if (tokenData.smartMoney?.smartMoneyScore >= pattern.conditions.smart_money_min) matchScore++;
    }

    if (totalChecks > 0 && matchScore / totalChecks >= 0.6) {
      matches.push({
        pattern: pattern.pattern_name,
        winRate: pattern.win_rate || 0,
        sampleSize: pattern.sample_size || 0,
        confidence: matchScore / totalChecks
      });
    }
  }

  return matches.sort((a, b) => b.winRate - a.winRate);
}

module.exports = { findMatchingPatterns };