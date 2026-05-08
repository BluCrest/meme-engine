const db = require('../database/db');

// Dynamic smart money wallet set — self-seeded from profitable trades
let SMART_MONEY_WALLETS = [];

// Seed smart money from our own profitable closed trades
async function seedFromOwnTrades() {
  try {
    const closedTrades = await db.getDb().collection('trades')
      .find({ action: 'sell', sol_amount: { $gt: 0 } })
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();

    // Group by token, find profitable sells
    const tokenProfits = {};
    for (const t of closedTrades) {
      if (!tokenProfits[t.token_address]) tokenProfits[t.token_address] = { buys: [], sells: [] };
      if (t.action === 'buy') tokenProfits[t.token_address].buys.push(t);
      else tokenProfits[t.token_address].sells.push(t);
    }

    // For each profitable token, get the deployer from our DB and add them
    for (const [addr, trades] of Object.entries(tokenProfits)) {
      const totalBuySol = trades.buys.reduce((s, t) => s + (t.sol_amount || 0), 0);
      const totalSellSol = trades.sells.reduce((s, t) => s + (t.sol_amount || 0), 0);
      if (totalSellSol > totalBuySol * 1.1) { // Profitable
        const token = await db.getToken(addr);
        if (token?.dev_wallet && !SMART_MONEY_WALLETS.includes(token.dev_wallet)) {
          SMART_MONEY_WALLETS.push(token.dev_wallet);
          console.log(`[SmartMoney] Auto-seeded profitable deployer: ${token.dev_wallet.slice(0, 8)}...`);
        }
      }
    }
  } catch (_) {}
}

async function getOrBuildWalletProfile(walletAddress) {
  let profile = await db.getDb().collection('wallets').findOne({ address: walletAddress });

  if (profile && profile.updated_at) {
    const ageHours = (Date.now() - new Date(profile.updated_at).getTime()) / 3600000;
    if (ageHours < 24) return profile;
  }

  // Analyze wallet via our recorded trades
  try {
    const walletTrades = await db.getDb().collection('wallet_positions')
      .find({ wallet_address: walletAddress })
      .toArray();

    if (walletTrades.length > 0) {
      const wins = walletTrades.filter(t => (t.pnl || 0) > 0);
      const winRate = walletTrades.length > 0 ? wins.length / walletTrades.length : 0.5;
      const avgReturn = walletTrades.length > 0
        ? walletTrades.reduce((s, t) => s + (t.exit_multiple || 1), 0) / walletTrades.length
        : 1.0;

      const label = winRate > 0.7 && walletTrades.length >= 10 ? 'smart_money'
        : winRate > 0.5 ? 'whale'
        : winRate < 0.3 ? 'bot'
        : 'fomo';

      profile = {
        address: walletAddress,
        label,
        total_trades: walletTrades.length,
        win_rate: winRate,
        avg_entry_mc: average(walletTrades.map(t => t.entry_mc || 0)),
        avg_exit_return: avgReturn,
        updated_at: new Date()
      };

      await db.getDb().collection('wallets').updateOne(
        { address: walletAddress },
        { $set: profile },
        { upsert: true }
      );
      return profile;
    }
  } catch (_) {}

  // Fallback: placeholder
  profile = {
    address: walletAddress,
    label: 'unknown',
    total_trades: 0,
    win_rate: 0.5,
    avg_entry_mc: 0,
    avg_exit_return: 1.0,
    updated_at: new Date()
  };

  await db.getDb().collection('wallets').updateOne(
    { address: walletAddress },
    { $set: profile },
    { upsert: true }
  );

  return profile;
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Run seeding on startup
seedFromOwnTrades();

async function getSmartMoneyScore(tokenAddress) {
  // Get top holders of the token
  const topHolders = await getTopHolders(tokenAddress, 20);

  let smartMoneyCount = 0;
  const smartMoneyDetails = [];

  for (const holder of topHolders) {
    // Check if this wallet is in our smart money list
    const isKnownSmart = SMART_MONEY_WALLETS.includes(holder.address);

    // Or check if wallet has good profile
    const walletProfile = await getOrBuildWalletProfile(holder.address);

    const isSmart = isKnownSmart ||
      (walletProfile.win_rate > 0.6 &&
       walletProfile.avg_exit_return > 2.0);

    if (isSmart) {
      smartMoneyCount++;
      smartMoneyDetails.push({
        wallet: holder.address.slice(0, 8) + '...',
        winRate: walletProfile.win_rate,
        avgReturn: walletProfile.avg_exit_return,
        label: walletProfile.label
      });
    }
  }

  const score = Math.min(100, smartMoneyCount * 15);

  return {
    smartMoneyScore: score,
    smartMoneyWallets: smartMoneyDetails,
    smartMoneyCount,
    isSmartMoneyPresent: smartMoneyCount > 0
  };
}

const { getTopHolders: fetchHolders } = require('../utils/holders');

async function getTopHolders(tokenAddress, limit = 20) {
  return fetchHolders(tokenAddress, limit);
}

async function addSmartMoneyWallet(walletAddress) {
  if (!SMART_MONEY_WALLETS.includes(walletAddress)) {
    SMART_MONEY_WALLETS.push(walletAddress);
    console.log(`[SmartMoney] Added ${walletAddress} to smart money list`);
  }
}

async function copyTradeCheck(tokenAddress) {
  // Check if any smart money wallets are buying this token
  const recentTrades = await db.getDb().collection('wallet_positions')
    .find({
      token_address: tokenAddress,
      timestamp: { $gte: new Date(Date.now() - 30 * 60000) } // Last 30 min
    })
    .toArray();

  const smartBuys = recentTrades.filter(t =>
    SMART_MONEY_WALLETS.includes(t.wallet_address)
  );

  return {
    copyTradeSignal: smartBuys.length > 0,
    smartWalletsBuying: smartBuys.length,
    details: smartBuys
  };
}

module.exports = {
  getSmartMoneyScore,
  getOrBuildWalletProfile,
  addSmartMoneyWallet,
  copyTradeCheck,
  SMART_MONEY_WALLETS
};