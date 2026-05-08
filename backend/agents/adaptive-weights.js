const db = require('../database/db');

class AdaptiveWeights {
  constructor() {
    this.weights = {
      safetyWeight: { base: 0.40, min: 0.25, max: 0.55, step: 0.01 },
      smartWeight: { base: 0.40, min: 0.25, max: 0.55, step: 0.01 },
      devModifier: { base: 12, min: 5, max: 20, step: 0.5 },
      mcBonus: { base: 1.0, min: 0.5, max: 2.0, step: 0.05 },
      freshnessBonus: { base: 1.0, min: 0.5, max: 2.0, step: 0.05 },
      volMcBonus: { base: 1.0, min: 0.5, max: 2.0, step: 0.05 },
      smConfidenceBonus: { base: 1.0, min: 0.5, max: 2.0, step: 0.05 }
    };
    // Per-weight result tracking
    this.weightResults = {};
    for (const key of Object.keys(this.weights)) {
      this.weightResults[key] = [];
    }
    this.lastNResults = [];
    this.maxHistory = 50;
  }

  getCurrentWeights() {
    const w = {};
    for (const [key, cfg] of Object.entries(this.weights)) {
      w[key] = cfg.base;
    }
    return w;
  }

  async recordResult(tokenAddress, score, outcome, featureScores = null) {
    this.lastNResults.push({ score, outcome, time: Date.now(), featureScores });
    if (this.lastNResults.length > this.maxHistory) {
      this.lastNResults.shift();
    }
    // Track per-weight if feature scores provided
    if (featureScores) {
      for (const [key, fScore] of Object.entries(featureScores)) {
        if (this.weightResults[key]) {
          this.weightResults[key].push({ score: fScore, outcome, time: Date.now() });
          if (this.weightResults[key].length > this.maxHistory) {
            this.weightResults[key].shift();
          }
        }
      }
    }
    try {
      await db.getDb().collection('adaptive_weights').updateOne(
        { token_address: tokenAddress },
        { $set: { score, outcome, recorded_at: new Date() } },
        { upsert: true }
      );
    } catch (_) {}
  }

  async adjustWeights() {
    const recent = this.lastNResults.slice(-20);
    if (recent.length < 5) return this.getCurrentWeights();

    // Per-weight adjustment: each weight adjusts based on how well
    // its feature scores predicted win vs loss
    for (const [key, cfg] of Object.entries(this.weights)) {
      const wResults = this.weightResults[key] || [];
      const recentW = wResults.slice(-20);
      if (recentW.length < 3) continue; // Not enough data for this weight

      const wWins = recentW.filter(r => (r.outcome || 0) > 0);
      const wLosses = recentW.filter(r => (r.outcome || 0) <= 0);

      if (!wWins.length || !wLosses.length) continue;

      const avgWinFeature = wWins.reduce((s, r) => s + (r.score || 0), 0) / wWins.length;
      const avgLossFeature = wLosses.reduce((s, r) => s + (r.score || 0), 0) / wLosses.length;

      // If this feature scores higher in wins than losses, feature is predictive → increase weight
      // If this feature scores similarly in both, it has low predictive power → decrease weight
      const featureAccuracy = (avgWinFeature - avgLossFeature) / Math.max(avgLossFeature, 0.01);
      const adjustment = Math.max(-1, Math.min(1, featureAccuracy)) * cfg.step;

      cfg.base = Math.max(cfg.min, Math.min(cfg.max, cfg.base + adjustment));
    }

    return this.getCurrentWeights();
  }
}

module.exports = new AdaptiveWeights();
