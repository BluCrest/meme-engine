const { getTopHolders, getHolderBalanceAt } = require('../utils/holders');
const { executeWithFallback } = require('../utils/rpc-rotator');
const { SMART_MONEY_WALLETS } = require('../profiler/smart-money');
const db = require('../database/db');

const HOLDER_SNAPSHOT_TTL = 300000;
const holderSnapshots = new Map();

async function getTopHolderWallets(tokenAddress, limit = 20) {
  const holders = await getTopHolders(tokenAddress, limit);
  return holders.map(h => h.address);
}

async function areSmartWalletsDumping(tokenAddress, symbol) {
  try {
    const currentHolders = await getTopHolderWallets(tokenAddress, 20);
    const holderSet = new Set(currentHolders);

    const smartWalletsInToken = SMART_MONEY_WALLETS.filter(w => holderSet.has(w));
    if (!smartWalletsInToken.length) return null;

    const snapshot = holderSnapshots.get(tokenAddress);
    const now = Date.now();

    if (snapshot && now - snapshot.ts < HOLDER_SNAPSHOT_TTL) {
      const prevSmart = new Set(snapshot.smartWallets);
      const dropped = smartWalletsInToken.filter(w => !prevSmart.has(w));
      const stillHolding = smartWalletsInToken.filter(w => prevSmart.has(w));

      if (dropped.length > 0) {
        return {
          triggered: true,
          reason: 'wallet_dump',
          droppedWallets: dropped,
          droppedCount: dropped.length,
          stillHolding: stillHolding.length,
          message: `💀 *WALLET DUMP* — ${dropped.length} smart wallet(s) sold $${symbol || tokenAddress.slice(0, 8)}`
        };
      }

      if (stillHolding.length < smartWalletsInToken.length * 0.5 && smartWalletsInToken.length >= 3) {
        return {
          triggered: true,
          reason: 'wallet_exodus',
          droppedWallets: dropped || [],
          droppedCount: stillHolding.length,
          stillHolding: stillHolding.length,
          message: `🚨 *WALLET EXODUS* — ${smartWalletsInToken.length - stillHolding.length} of ${smartWalletsInToken.length} smart wallets sold $${symbol || tokenAddress.slice(0, 8)}`
        };
      }
    }

    holderSnapshots.set(tokenAddress, { smartWallets: smartWalletsInToken, ts: now });
    return null;
  } catch (_) { return null; }
}

async function checkSmartWalletBalances(tokenAddress) {
  try {
    const currentHolders = await getTopHolderWallets(tokenAddress, 20);
    const holderSet = new Set(currentHolders);

    const smartWalletsInToken = SMART_MONEY_WALLETS.filter(w => holderSet.has(w));
    if (!smartWalletsInToken.length) return null;

    let totalDropped = 0;
    for (const wallet of smartWalletsInToken) {
      const bal = await getHolderBalanceAt(wallet, tokenAddress, Date.now());
      if (bal === 0 || bal === null) totalDropped++;
    }

    if (totalDropped >= Math.ceil(smartWalletsInToken.length * 0.5)) {
      return {
        triggered: true,
        reason: 'smart_balance_drop',
        totalDropped,
        totalSmart: smartWalletsInToken.length,
        message: `🚨 ${totalDropped}/${smartWalletsInToken.length} smart wallets zeroed out on $${tokenAddress.slice(0, 8)}`
      };
    }
    return null;
  } catch (_) { return null; }
}

module.exports = { areSmartWalletsDumping, checkSmartWalletBalances };
