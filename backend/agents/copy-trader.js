// Copy trader — discovers profitable wallets by tracking deployers + early holders.
// When a known-good wallet launches or buys a new token, triggers momentum entry.
const db = require('../database/db');

const REPUTATION_COLLECTION = 'wallet_reputation';
const MIN_OBSERVATIONS = 2;

const GMGN_WALLET_RANK_URL = 'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets';

class CopyTrader {
  constructor() {
    this.cachedReputations = new Map();
    this.refreshInterval = 300000;
    this.lastRefresh = 0;
  }

  async refreshCache() {
    if (Date.now() - this.lastRefresh < this.refreshInterval) return;
    try {
      const docs = await db.getDb().collection(REPUTATION_COLLECTION)
        .find({ observations: { $gte: MIN_OBSERVATIONS } })
        .sort({ score: -1 })
        .limit(100)
        .toArray();
      this.cachedReputations.clear();
      for (const d of docs) {
        this.cachedReputations.set(d.wallet, d);
      }
      this.lastRefresh = Date.now();
      if (docs.length) console.log(`[CopyTrader] Loaded ${docs.length} tracked wallets`);
    } catch (_) {}
  }

  // Fetch top wallets from GMGN ranking API
  async seedFromGMGN() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`${GMGN_WALLET_RANK_URL}/7d?orderby=pnl&direction=desc&limit=30`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const data = await res.json();
      const wallets = data?.data || [];
      let seeded = 0;
      for (const w of wallets) {
        const wallet = w.wallet || w.address;
        if (!wallet) continue;
        const score = Math.round(Math.max(0, Math.min(100, (w.pnl_7d || 0) * 10 + (w.win_rate || 0) * 0.5)));
        await db.getDb().collection(REPUTATION_COLLECTION).updateOne(
          { wallet },
          {
            $set: {
              score,
              role: 'gmgn_trader',
              observations: w.trade_count || 10,
              totalTokens: w.trade_count || 10,
              sumReturns: (w.pnl_7d || 0) * 100,
              avgReturn: (w.avg_return || 0) * 100,
              winRate: w.win_rate || 0,
              lastActive: new Date()
            },
            $min: { firstSeen: new Date() },
            $setOnInsert: { source: 'gmgn_rank' }
          },
          { upsert: true }
        );
        seeded++;
      }
      if (seeded) console.log(`[CopyTrader] Seeded ${seeded} wallets from GMGN ranking`);
      return wallets;
    } catch (e) {
      console.log(`[CopyTrader] GMGN seed unavailable: ${e.message}`);
      return [];
    }
  }

  getTopWallets(limit = 20) {
    return Array.from(this.cachedReputations.values())
      .filter(w => w.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async observeToken(tokenAddress, deployer, symbol, initialPrice) {
    if (!deployer) return;
    const entry = {
      wallet: deployer,
      role: 'deployer',
      tokenAddress,
      symbol: symbol || '?',
      observedAt: new Date(),
      entryPrice: initialPrice || 0,
      peakPrice: initialPrice || 0,
      currentPrice: initialPrice || 0
    };
    try {
      await db.getDb().collection('wallet_observations').insertOne(entry);
      // Update deployer reputation
      await this._updateReputation(deployer, 'deployer', tokenAddress);
    } catch (_) {}
  }

  async recordPrice(tokenAddress, currentPrice) {
    try {
      const observations = await db.getDb().collection('wallet_observations')
        .find({ tokenAddress, peakPrice: { $lt: currentPrice } })
        .toArray();
      for (const obs of observations) {
        await db.getDb().collection('wallet_observations').updateOne(
          { _id: obs._id },
          { $set: { peakPrice: currentPrice, currentPrice } }
        );
      }
    } catch (_) {}
  }

  async finalizeToken(tokenAddress, exitPrice) {
    try {
      const observations = await db.getDb().collection('wallet_observations')
        .find({ tokenAddress })
        .toArray();
      for (const obs of observations) {
        const returnPct = obs.entryPrice > 0 ? (exitPrice / obs.entryPrice) - 1 : 0;
        await db.getDb().collection('wallet_observations').updateOne(
          { _id: obs._id },
          { $set: { exitPrice, returnPct, finalizedAt: new Date() } }
        );
        await this._updateReputation(obs.wallet, obs.role, tokenAddress, returnPct);
      }
      await db.getDb().collection('wallet_observations').deleteMany({ tokenAddress });
    } catch (_) {}
  }

  async _updateReputation(wallet, role, tokenAddress, returnPct) {
    const update = {};
    if (returnPct !== undefined) {
      update.$inc = { totalTokens: 1, sumReturns: returnPct };
      update.$set = { lastActive: new Date() };
      update.$push = { recentTokens: { address: tokenAddress, returnPct, time: new Date() } };
    } else {
      update.$inc = { totalTokens: 1 };
      update.$set = { lastActive: new Date() };
    }

    try {
      await db.getDb().collection(REPUTATION_COLLECTION).updateOne(
        { wallet },
        {
          ...update,
          $min: { firstSeen: new Date() },
          $setOnInsert: { role, observations: 0, score: 0 }
        },
        { upsert: true }
      );

      // Recompute score
      const rep = await db.getDb().collection(REPUTATION_COLLECTION).findOne({ wallet });
      if (rep && rep.totalTokens > 0) {
        const avgReturn = rep.sumReturns / rep.totalTokens;
        const observations = rep.totalTokens;
        const score = Math.round(Math.max(-50, Math.min(100, avgReturn * 100 - (observations > 5 ? 0 : 20))));
        await db.getDb().collection(REPUTATION_COLLECTION).updateOne(
          { wallet },
          { $set: { score, observations, avgReturn } }
        );
      }
    } catch (_) {}
  }

  async isProfitableDeployer(deployer) {
    await this.refreshCache();
    const rep = this.cachedReputations.get(deployer);
    if (!rep) return null;
    return rep.score > 10 ? { score: rep.score, avgReturn: rep.avgReturn, totalTokens: rep.totalTokens } : null;
  }

  async getDeployerScore(deployer) {
    await this.refreshCache();
    const rep = this.cachedReputations.get(deployer);
    return rep ? rep.score : 0;
  }
}

module.exports = new CopyTrader();
