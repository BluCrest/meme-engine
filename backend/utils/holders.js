require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../config');

const connection = new Connection(config.helius.rpcUrl || process.env.SOLANA_RPC_URL, 'confirmed');

/**
 * Get top holders of a Solana token using Helius RPC
 * Returns array of { address, balance, rank }
 */
async function getTopHolders(tokenAddress, limit = 10) {
  try {
    const mintPublicKey = new PublicKey(tokenAddress);

    // Get largest token accounts
    const accounts = await connection.getTokenLargestAccounts(mintPublicKey);
    const topAccounts = accounts.value.slice(0, limit);

    // Get owner wallet for each token account
    const holders = await Promise.all(
      topAccounts.map(async (account, index) => {
        try {
          const accountInfo = await connection.getParsedAccountInfo(account.address);
          const info = accountInfo.value?.data?.parsed?.info;
          const owner = info?.owner || 'unknown';
          const balance = (account.uiAmount || parseInt(account.amount) / 1e6); // rough decimals

          return {
            address: owner,
            balance: balance,
            tokenAccount: account.address.toString(),
            rank: index + 1
          };
        } catch (err) {
          return {
            address: 'unknown',
            balance: 0,
            tokenAccount: account.address.toString(),
            rank: index + 1
          };
        }
      })
    );

    // Filter out unknown/invalid
    return holders.filter(h => h.address !== 'unknown' && h.address !== '');
  } catch (err) {
    console.error('[Holders] Error:', err.message);
    return [];
  }
}

/**
 * Get token total supply
 */
async function getTotalSupply(tokenAddress) {
  try {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(tokenAddress));
    const supply = mintInfo.value?.data?.parsed?.info?.supply;
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals || 0;
    return parseInt(supply) / Math.pow(10, decimals);
  } catch (err) {
    console.error('[Holders] Supply error:', err.message);
    return 0;
  }
}

/**
 * Get holder balance at a specific point in time
 * Note: This requires historical tracking. For now, returns current balance.
 * TODO: Implement historical balance tracking via DB snapshots
 */
async function getHolderBalanceAt(holderAddress, tokenAddress, timestamp) {
  // For now, return current balance
  // In production, query price_snapshots DB collection
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(holderAddress),
      { mint: new PublicKey(tokenAddress) }
    );
    const balance = tokenAccounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
    return balance;
  } catch (err) {
    return 0;
  }
}

module.exports = { getTopHolders, getTotalSupply, getHolderBalanceAt };