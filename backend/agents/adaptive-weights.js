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

  async recordResult(tokenAddress, score, outcome) {
    this.lastNResults.push({ score, outcome, time: Date.now() });
    if (this.lastNResults.length > this.maxHistory) {
      this.lastNResults.shift();
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

    const wins = recent.filter(r => (r.outcome || 0) > 0);
    const losses = recent.filter(r => (r.outcome || 0) <= 0);
    if (!wins.length || !losses.length) return this.getCurrentWeights();

    const avgWinScore = wins.reduce((s, r) => s + r.score, 0) / wins.length;
    const avgLossScore = losses.reduce((s, r) => s + r.score, 0) / losses.length;

    // If winning trades had higher scores on average, our scoring is directionally correct
    // If losing trades had higher scores, we're overvaluing something
    const scoreAccuracy = avgWinScore > avgLossScore ? 0.05 : -0.05;

    for (const [key, cfg] of Object.entries(this.weights)) {
      cfg.base = Math.max(cfg.min, Math.min(cfg.max, cfg.base + scoreAccuracy * cfg.step));
    }

    return this.getCurrentWeights();
  }
}

module.exports = new AdaptiveWeights();
