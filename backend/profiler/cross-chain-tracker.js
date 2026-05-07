const axios = require('axios');
const config = require('../config');
const db = require('../database/db');

const DEBRIDGE_API = 'https://api.debridge.finance/v1.0';

// Get bridge transactions for a Solana wallet
async function getBridgeTransactions(solanaWallet) {
  try {
    const res = await axios.get(DEBRIDGE_API + '/transfers', {
      params: {
        srcChain: 'solana',
        srcAddress: solanaWallet,
        limit: 50
      }
    });
    return res.data.transfers || [];
  } catch (e) {
    console.error('[CrossChain] Bridge tx error:', e.message);
    return [];
  }
}

// Find bridged wallets (EVM) from bridge transactions
async function findBridgedWallets(solanaWallet) {
  const txs = await getBridgeTransactions(solanaWallet);
  const wallets = new Set();

  for (const tx of txs) {
    if (tx.dstChain === 'ethereum' || tx.dstChain === 'base') {
      if (tx.dstAddress) wallets.add({
        address: tx.dstAddress,
        chain: tx.dstChain
      });
    }
  }

  return Array.from(wallets);
}

// Get tokens created by an EVM wallet via Etherscan/BaseScan
async function getTokensCreatedByEVMWallet(walletAddress, chain) {
  const apiKey = chain === 'ethereum' ? config.etherscan.apiKey : config.baseScan.apiKey;
  const baseUrl = chain === 'ethereum' ? 'https://api.etherscan.io/api' : 'https://api.basescan.org/api';

  try {
    const res = await axios.get(baseUrl, {
      params: {
        module: 'account',
        action: 'txlist',
        address: walletAddress,
        apikey: apiKey
      }
    });

    const txs = res.data.result || [];
    const contractTxs = txs.filter(tx => tx.to === null && tx.input !== '0x');

    return contractTxs.map(tx => ({
      address: tx.contractAddress,
      chain: chain,
      createdAt: new Date(tx.timeStamp * 1000)
    }));
  } catch (e) {
    console.error('[CrossChain] EVM token fetch error:', e.message);
    return [];
  }
}

// Check if token rugged (price went to near zero)
async function checkIfRugged(tokenAddress, chain) {
  try {
    const chainSlug = chain === 'ethereum' ? 'ethereum' : 'base';
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chainSlug}/${tokenAddress}`);
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return false;

    const currentPrice = parseFloat(pair.priceUsd) || 0;
    // Use 24h high as peak proxy, or all-time high if available
    const peakPrice = parseFloat(pair.high24h || pair.priceUsd) || 0;

    // If price dropped >90% from peak, consider it rugged
    if (peakPrice <= 0) return false;
    return currentPrice < peakPrice * 0.1;
  } catch (e) {
    console.error('[CrossChain] Rug check error:', e.message);
    return false;
  }
}

async function checkCrossChainHistory(solanaWallet) {
  const result = {
    ethWallet: null,
    baseWallet: null,
    crossChainRugs: 0,
    crossChainLaunches: 0,
    crossChainFlag: false
  };

  try {
    console.log(`[CrossChain] Checking ${solanaWallet}...`);

    // 1. Find bridged wallets
    const bridged = await findBridgedWallets(solanaWallet);
    if (bridged.length === 0) {
      console.log('[CrossChain] No bridged wallets found');
      return result;
    }

    // 2. Check each bridged wallet
    for (const wallet of bridged) {
      if (wallet.chain === 'ethereum') result.ethWallet = wallet.address;
      if (wallet.chain === 'base') result.baseWallet = wallet.address;

      // 3. Get tokens created by this wallet
      const tokens = await getTokensCreatedByEVMWallet(wallet.address, wallet.chain);
      result.crossChainLaunches += tokens.length;

      // 4. Check for rugs
      for (const token of tokens) {
        const rugged = await checkIfRugged(token.address, wallet.chain);
        if (rugged) result.crossChainRugs++;
      }
    }

    result.crossChainFlag = result.crossChainRugs > 0;

    // 5. Save to DB
    await db.updateDevProfileCrossChain(solanaWallet, result);

    console.log(`[CrossChain] ${solanaWallet}: ${result.crossChainRugs} rugs / ${result.crossChainLaunches} launches`);

  } catch (e) {
    console.error('[CrossChain] Error:', e.message);
  }

  return result;
}

module.exports = { checkCrossChainHistory };
