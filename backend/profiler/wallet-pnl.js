const db = require('../database/db');

async function updateWalletPnL(walletAddress, tokenAddress, buyAmountSol, buyMC, sellMC) {
  const returnMultiple = buyMC > 0 ? sellMC / buyMC : 0;
  const pnl = (returnMultiple - 1) * buyAmountSol;

  const position = {
    wallet_address: walletAddress,
    token_address: tokenAddress,
    buy_amount_sol: buyAmountSol,
    buy_mc: buyMC,
    sell_mc: sellMC,
    return_multiple: returnMultiple,
    timestamp: new Date()
  };

  await db.getDb().collection('wallet_positions').insertOne(position);

  // Update wallet profile
  await recalculateWalletStats(walletAddress);

  return position;
}

async function recalculateWalletStats(walletAddress) {
  const positions = await db.getDb().collection('wallet_positions')
    .find({ wallet_address: walletAddress })
    .toArray();

  if (!positions.length) return;

  const wins = positions.filter(p => (p.return_multiple || 0) > 1).length;
  const winRate = wins / positions.length;

  const avgEntryMC = positions.reduce((sum, p) => sum + (p.buy_mc || 0), 0) / positions.length;
  const avgExitReturn = positions.reduce((sum, p) => sum + (p.return_multiple || 0), 0) / positions.length;

  const label =
    winRate > 0.7 && positions.length >= 20 ? 'smart_money' :
    winRate > 0.5 ? 'whale' :
    winRate < 0.3 ? 'bot' : 'fomo';

  await db.getDb().collection('wallets').updateOne(
    { address: walletAddress },
    {
      $set: {
        total_trades: positions.length,
        win_rate: winRate,
        avg_entry_mc: avgEntryMC,
        avg_exit_return: avgExitReturn,
        label,
        updated_at: new Date()
      }
    },
    { upsert: true }
  );
}

async function getWalletProfile(walletAddress) {
  return await db.getDb().collection('wallets').findOne({ address: walletAddress });
}

async function getTopPerformingWallets(limit = 10) {
  return await db.getDb().collection('wallets')
    .find({})
    .sort({ win_rate: -1, total_trades: -1 })
    .limit(limit)
    .toArray();
}

// Call this when we detect a trade by any wallet
async function trackWalletTrade(walletAddress, tokenAddress, type, amountSol, mc) {
  if (type === 'buy') {
    await db.getDb().collection('wallet_positions').insertOne({
      wallet_address: walletAddress,
      token_address: tokenAddress,
      buy_amount_sol: amountSol,
      buy_mc: mc,
      timestamp: new Date()
    });
  } else if (type === 'sell') {
    const position = await db.getDb().collection('wallet_positions').findOne({
      wallet_address: walletAddress,
      token_address: tokenAddress,
      sell_mc: { $exists: false }
    });

    if (position) {
      await db.getDb().collection('wallet_positions').updateOne(
        { _id: position._id },
        { $set: { sell_mc: mc, return_multiple: (mc / position.buy_mc) - 1 } }
      );
      await recalculateWalletStats(walletAddress);
    }
  }
}

module.exports = {
  updateWalletPnL,
  recalculateWalletStats,
  getWalletProfile,
  getTopPerformingWallets,
  trackWalletTrade
};