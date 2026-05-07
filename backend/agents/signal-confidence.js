const CONVICTION_RULES = {
  very_high: {
    minScore: 75,
    requires: { smartMoneyCount: 3, safetyScore: 60, momentumActive: true },
    label: '🔷 VERY HIGH',
    rank: 4
  },
  high: {
    minScore: 60,
    requires: { smartMoneyCount: 1, safetyScore: 50, momentumActive: true },
    label: '🟢 HIGH',
    rank: 3
  },
  medium: {
    minScore: 40,
    requires: { safetyScore: 40 },
    label: '🟡 MEDIUM',
    rank: 2
  },
  low: {
    minScore: 0,
    requires: {},
    label: '🔴 LOW',
    rank: 1
  }
};

function computeConviction(tokenData) {
  const { safety, smartMoney, vitality, social } = tokenData;
  const score = tokenData.apeProbability || 0;
  const smCount = smartMoney?.smartMoneyCount || 0;
  const safetyScore = safety?.safetyScore || 0;
  const momentumActive = vitality?.momentum === 'active';
  const socialActive = (social?.socialScore || 0) > 0 && (social?.isExponential || false);

  // Count how many independent positive signals
  let signalCount = 0;
  let signalDetails = [];

  // Safety signal
  if (safetyScore >= 60) { signalCount++; signalDetails.push('safe'); }
  // Smart money signal
  if (smCount >= 1) { signalCount++; signalDetails.push(`smart(${smCount})`); }
  // Momentum signal
  if (momentumActive) { signalCount++; signalDetails.push('alive'); }
  // Social signal (rare, X API typically disabled)
  if (socialActive) { signalCount++; signalDetails.push('viral'); }
  // Freshness
  const age = tokenData.tokenAge || 999;
  if (age < 10) { signalCount++; signalDetails.push('fresh'); }

  // Contradiction detection
  let contradictions = [];
  if (safetyScore > 70 && !safety?.ownershipRenounced) contradictions.push('high_safety_but_not_renounced');
  if (smCount >= 3 && momentumActive === false) contradictions.push('smart_money_no_momentum');
  if (score >= 60 && vitality?.isDead) contradictions.push('high_score_but_dead');

  // Determine conviction level
  let conviction = 'low';
  for (const [level, rules] of Object.entries(CONVICTION_RULES)) {
    if (score < rules.minScore) continue;
    const reqMet = Object.entries(rules.requires).every(([key, val]) => {
      if (key === 'smartMoneyCount') return smCount >= val;
      if (key === 'safetyScore') return safetyScore >= val;
      if (key === 'momentumActive') return momentumActive === val;
      return true;
    });
    if (reqMet) conviction = level;
  }

  // Downgrade on contradictions
  if (contradictions.length >= 2 && conviction === 'very_high') conviction = 'high';
  if (contradictions.length >= 3 && conviction === 'high') conviction = 'medium';

  return {
    conviction,
    label: CONVICTION_RULES[conviction]?.label || '🔴 LOW',
    rank: CONVICTION_RULES[conviction]?.rank || 1,
    signalCount,
    signalDetails,
    contradictions,
    healthySignalRatio: signalCount / Math.max(1, signalCount + contradictions.length)
  };
}

module.exports = { computeConviction };
