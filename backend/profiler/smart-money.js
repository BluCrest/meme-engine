const db = require('../database/db');

// List of smart money wallets to track (seed this with known winners)
// TODO: Add 5-10 wallet addresses of proven winners
const SMART_MONEY_WALLETS = [
  // 'wallet_address_1',
  // 'wallet_address_2',
];

async function getOrBuildWalletProfile(walletAddress) {
  let profile = await db.getDb().collection('wallets').findOne({ address: walletAddress });

  if (profile && profile.updated_at) {
    const ageHours = (Date.now() - new Date(profile.updated_at).getTime()) / 3600000;
    if (ageHours < 24) return profile; // Fresh enough
  }

  // TODO: Analyze wallet's historical trades via Helius
  // For now, create placeholder profile
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