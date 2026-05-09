const { Connection, PublicKey } = require('@solana/web3.js');
const { executeWithFallback } = require('../utils/rpc-rotator');
const db = require('../database/db');

const OUTFLOW_BUFFER_MIN = 0.1;
const SOL_THRESHOLD = 0.05;

async function checkDevOutflow(devWallet, tokenAddress) {
  try {
    const pubkey = new PublicKey(devWallet);
    const rpc = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const sigs = await rpc.getSignaturesForAddress(pubkey, { limit: 10 });
    if (!sigs.length) return null;

    const recentTxs = await rpc.getTransactions(
      sigs.map(s => s.signature),
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }
    );

    for (let i = 0; i < recentTxs.length; i++) {
      const tx = recentTxs[i];
      if (!tx || !tx.meta) continue;
      const pre = tx.meta.preBalances?.[0] || 0;
      const post = tx.meta.postBalances?.[0] || 0;
      const solOut = (pre - post) / 1e9;
      if (solOut >= SOL_THRESHOLD) {
        const slot = tx.slot || 0;
        const time = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
        const minutesAgo = (Date.now() - time.getTime()) / 60000;
        if (minutesAgo < 30) {
          return {
            triggered: true,
            reason: 'dev_outflow',
            message: `👤 *DEV OUTFLOW* — Dev moved ${solOut.toFixed(3)} SOL ${minutesAgo.toFixed(0)}m ago (tx slot ${slot})`
          };
        }
      }
    }

    const { getTokenAccountsByOwner } = require('../utils/rpc-helpers');
    const tokenAccounts = await getTokenAccountsByOwner(pubkey).catch(() => []);
    const tokenAccount = tokenAccounts.find(a => a.mint === tokenAddress);
    if (tokenAccount) {
      const currentBalance = Number(tokenAccount.amount) / 1e6;
      const cached = await db.getDb().collection('dev_holdings').findOne({ token_address: tokenAddress, wallet: devWallet });
      if (cached && cached.balance > 0) {
        const dropRatio = (cached.balance - currentBalance) / cached.balance;
        if (dropRatio > OUTFLOW_BUFFER_MIN) {
          return {
            triggered: true,
            reason: 'dev_token_dump',
            message: `👤 *DEV TOKEN DUMP* — Dev sold ${(dropRatio * 100).toFixed(0)}% of their holdings`
          };
        }
      }
      await db.getDb().collection('dev_holdings').updateOne(
        { token_address: tokenAddress, wallet: devWallet },
        { $set: { balance: currentBalance, checked_at: new Date() } },
        { upsert: true }
      );
    }

    return null;
  } catch (_) {
    return null;
  }
}

module.exports = { checkDevOutflow };
