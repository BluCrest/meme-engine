const db = require('../database/db');

class PatternMemory {
  constructor() {
    this.devCache = new Map();
    this.patternCache = new Map();
    this.maxPatterns = 500;
  }

  async recordEvaluation(tokenAddress, features, score, wasBought, outcome) {
    const entry = {
      tokenAddress,
      features,
      score,
      wasBought,
      outcome,
      time: Date.now()
    };
    this.patternCache.set(tokenAddress, entry);
    if (this.patternCache.size > this.maxPatterns) {
      const firstKey = this.patternCache.keys().next().value;
      this.patternCache.delete(firstKey);
    }
    try {
      await db.getDb().collection('pattern_memory').insertOne(entry);
    } catch (_) {}
  }

  async recordTradeOutcome(tokenAddress, pnlPct, exitMultiplier) {
    try {
      await db.getDb().collection('pattern_memory').updateOne(
        { tokenAddress },
        { $set: { pnl_pct: pnlPct, exit_multiplier: exitMultiplier, closed_at: new Date() } }
      );
      const cached = this.patternCache.get(tokenAddress);
      if (cached) {
        cached.outcome = pnlPct;
        cached.exitMultiplier = exitMultiplier;
      }
    } catch (_) {}
  }

  async getDevHistory(devWallet) {
    try {
      const trades = await db.getDb().collection('trades')
        .find({ dev_wallet: devWallet })
        .sort({ timestamp: -1 })
        .limit(20)
        .toArray();
      return trades;
    } catch (_) { return []; }
  }

  async getSimilarTokens(mc, ageMin, volume) {
    const mcRange = mc * 0.3;
    try {
      const similar = await db.getDb().collection('pattern_memory')
        .find({
          'features.mc': { $gte: mc - mcRange, $lte: mc + mcRange },
          'features.age_min': { $gte: 0, $lte: ageMin + 5 }
        })
        .sort({ time: -1 })
        .limit(20)
        .toArray();
      return similar;
    } catch (_) { return []; }
  }

  async getWinRateByDev(devWallet) {
    try {
      const trades = await db.getDb().collection('trades')
        .find({ dev_wallet: devWallet, action: 'sell' })
        .toArray();
      if (!trades.length) return null;
      const wins = trades.filter(t => (t.pnl_pct || 0) > 0).length;
      return { total: trades.length, wins, winRate: wins / trades.length };
    } catch (_) { return null; }
  }

  getHistoricalBonus(features) {
    const recent = Array.from(this.patternCache.values())
      .filter(e => e.wasBought && e.outcome)
      .slice(-30);
    if (recent.length < 5) return 0;
    const wins = recent.filter(e => (e.outcome || 0) > 0).length;
    const winRate = wins / recent.length;
    if (winRate > 0.6) return 5;
    if (winRate < 0.3) return -5;
    return 0;
  }

  // Return tightening factor for exit params based on recent trade outcomes
  // >1 means tighten exits (losing streak), <1 means loosen (winning streak)
  getTighteningFactor() {
    const recent = Array.from(this.patternCache.values())
      .filter(e => e.wasBought && e.outcome !== null && e.outcome !== undefined)
      .slice(-20);
    if (recent.length < 3) return 1.0;
    const losses = recent.filter(e => (e.outcome || 0) <= 0).length;
    const lossRate = losses / recent.length;
    if (lossRate > 0.75) return 1.3;
    if (lossRate > 0.6) return 1.15;
    if (lossRate < 0.25) return 0.8;
    if (lossRate < 0.4) return 0.9;
    return 1.0;
  }
}

module.exports = new PatternMemory();
