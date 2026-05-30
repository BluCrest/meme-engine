const { executeWithFallback } = require('../utils/rpc-rotator');
const { decodeTransaction } = require('./tx-decoder');
const db = require('../database/db');
const config = require('../config');

const POLL_INTERVAL = 12000;
const MAX_TX_PER_POLL = 5;
const MIN_SOL_PER_COPY = 0.001;

const processedSigs = new Set();
const recentlyMirrored = new Map();
const MIRROR_COOLDOWN = 60000;

const targetWallets = [];
const walletAmounts = new Map();

function loadTargetWallets() {
  targetWallets.length = 0;
  walletAmounts.clear();
  const wallets = config.copyTrade?.targetWallets || [];
  if (!wallets.length) return;

  for (const entry of wallets) {
    const parts = entry.split(':');
    const addr = parts[0].trim();
    if (!addr) continue;
    targetWallets.push(addr);
    const amount = parseFloat(parts[1]);
    walletAmounts.set(addr, amount > 0 ? amount : null);
  }

  if (targetWallets.length) {
    console.log(`[CopyTrade] Monitoring ${targetWallets.length} wallet(s):`);
    for (const w of targetWallets) {
      const amt = walletAmounts.get(w);
      console.log(`  ${w.slice(0, 12)}...${w.slice(-4)}${amt ? ` (${amt.toFixed(4)} SOL per copy)` : ' (auto)'}`);
    }
  }
}

function isRecentlyMirrored(sig) {
  const ts = recentlyMirrored.get(sig);
  if (!ts) return false;
  if (Date.now() - ts > MIRROR_COOLDOWN) {
    recentlyMirrored.delete(sig);
    return false;
  }
  return true;
}

async function getCopySize(wallet) {
  const isPaper = await db.getPaperTrading();
  const configured = walletAmounts.get(wallet);

  if (configured) return configured;

  if (isPaper) return 0.005;

  const { getBalance } = require('../operator/trade-executor');
  const bal = await getBalance();
  const maxCopy = config.copyTrade?.maxSolPerCopy || 0.05;
  return Math.min(maxCopy, Math.max(MIN_SOL_PER_COPY, bal * 0.15));
}

async function processTransaction(tx, wallet) {
  try {
    const decoded = decodeTransaction(tx);
    if (!decoded) return;
    if (decoded.action !== 'buy' && decoded.action !== 'sell') return;

    if (isRecentlyMirrored(decoded.signature)) return;
    processedSigs.add(decoded.signature);
    if (processedSigs.size > 5000) processedSigs.clear();

    const isPaper = await db.getPaperTrading();
    const mode = isPaper ? 'paper_copy_trade' : 'copy_trade';

    if (decoded.action === 'buy') {
      const existing = await db.getDb().collection('positions').findOne({
        token_address: decoded.tokenMint,
        status: 'open'
      });
      if (existing) {
        console.log(`[CopyTrade] ${wallet.slice(0, 8)}... already in position on ${decoded.tokenMint.slice(0, 8)}... — skipping`);
        return;
      }

      const amount = await getCopySize(wallet);
      console.log(`[CopyTrade] 👥 COPY BUY: ${wallet.slice(0, 8)}... → ${decoded.tokenMint.slice(0, 8)}... mirroring ${amount.toFixed(4)} SOL${isPaper ? ' (paper)' : ''}`);

      const { executeBuy } = require('../operator/trade-executor');
      const result = await executeBuy(decoded.tokenMint, mode, amount);
      if (result?.success) {
        recentlyMirrored.set(decoded.signature, Date.now());
      }
    }

    if (decoded.action === 'sell') {
      const pos = await db.getDb().collection('positions').findOne({
        token_address: decoded.tokenMint,
        status: 'open'
      });
      if (!pos) {
        console.log(`[CopyTrade] ${wallet.slice(0, 8)}... sold ${decoded.tokenMint.slice(0, 8)}... but no open position — skip`);
        return;
      }

      console.log(`[CopyTrade] 👥 COPY SELL: ${wallet.slice(0, 8)}... → ${decoded.tokenMint.slice(0, 8)}... mirroring${isPaper ? ' (paper)' : ''}`);
      const { executeSell } = require('../operator/trade-executor');
      await executeSell(decoded.tokenMint, 1.0, 'copy_trade_sell');
      recentlyMirrored.set(decoded.signature, Date.now());
    }
  } catch (e) {
    console.error(`[CopyTrade] Tx processing error:`, e.message);
  }
}

async function pollWallet(wallet) {
  try {
    const { PublicKey } = require('@solana/web3.js');
    const pk = new PublicKey(wallet);
    const sigs = await executeWithFallback(conn =>
      conn.getSignaturesForAddress(pk, { limit: MAX_TX_PER_POLL })
    );
    if (!sigs || !sigs.length) return;

    for (const sigInfo of sigs) {
      if (processedSigs.has(sigInfo.signature)) continue;
      if (isRecentlyMirrored(sigInfo.signature)) continue;

      const tx = await executeWithFallback(conn =>
        conn.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
      );
      if (tx) {
        await processTransaction(tx, wallet);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  } catch (e) {
    if (!e.message?.includes('429') && !e.message?.includes('rate limit')) {
      console.error(`[CopyTrade] Poll error for ${wallet.slice(0, 8)}...:`, e.message?.slice(0, 100));
    }
  }
}

let pollTimer = null;

async function pollAll() {
  if (!targetWallets.length) return;
  for (const wallet of targetWallets) {
    await pollWallet(wallet);
  }
}

async function startCopyTrader() {
  loadTargetWallets();
  if (!targetWallets.length) {
    console.log('[CopyTrade] No target wallets configured — copy trader idle');
    return;
  }
  console.log(`[CopyTrade] Starting wallet monitor (every ${POLL_INTERVAL / 1000}s)...`);
  await pollAll();
  pollTimer = setInterval(pollAll, POLL_INTERVAL);
}

function stopCopyTrader() {
  if (pollTimer) clearInterval(pollTimer);
}

function reloadWallets() {
  loadTargetWallets();
}

module.exports = { startCopyTrader, stopCopyTrader, reloadWallets, targetWallets };
