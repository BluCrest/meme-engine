const { PublicKey } = require('@solana/web3.js');

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SOL_MINT = 'So11111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xr25ixUf12h1N8QKH';

const KNOWN_PROGRAMS = {
  'JUP6LkbZbjSa1jqMwoJ94zKNE6Tp3s4jLh8j4Hx2jDV': 'jupiter',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun',
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX': 'serum',
  '675kPX9MHTjS2zt1k6v3d9zU4HvM7TJHqLhS9rLgTn4': 'raydium_cpmm',
  'CAMMCzo5YLJwD4G9wYhD9P8T6eG2cJY6QzFkxRKxnVq': 'raydium_clmm',
  'LBUZKhwPFnyDzZnRntK8kC8STHaUG3JjsQcgyhGcxi': 'meteora',
  'whirLbMiicVdsioHqf6YHiwixTsiN2Lx3ni6GqSCxX': 'orca_whirlpool',
};

function decodeInstruction(data, programId) {
  const prog = KNOWN_PROGRAMS[programId] || 'unknown';

  if (prog === 'pumpfun' && data.length >= 8) {
    const discriminator = Buffer.from(data.slice(0, 8)).toString('hex');
    if (discriminator === '66063d1201daebea') return { type: 'pump_buy' };
    if (discriminator === '33e685a4017f83ad') return { type: 'pump_sell' };
    return { type: 'pumpfun', discriminator };
  }

  if (prog === 'jupiter') {
    if (data.length >= 8) {
      const disc = Buffer.from(data.slice(0, 8)).toString('hex');
      if (disc === 'f89b512144f7dd66') return { type: 'jupiter_swap' };
    }
    return { type: 'jupiter' };
  }

  return { type: prog };
}

function findTokenTransferAccounts(accounts, postBalances, preBalances, preTokenBalances, postTokenBalances) {
  const results = [];

  const solChanges = [];
  for (let i = 0; i < accounts.length; i++) {
    const pre = preBalances[i] || 0;
    const post = postBalances[i] || 0;
    const diff = post - pre;
    if (diff !== 0) {
      solChanges.push({ account: accounts[i], diff: diff / 1e9, index: i });
    }
  }

  const tokenChanges = [];
  for (let i = 0; i < (postTokenBalances || []).length; i++) {
    const post = postTokenBalances[i];
    if (!post) continue;
    const pre = (preTokenBalances || []).find(p => p.accountIndex === post.accountIndex);
    const preAmt = pre ? parseInt(pre.uiTokenAmount?.amount || '0') : 0;
    const postAmt = parseInt(post.uiTokenAmount?.amount || '0');
    const diff = postAmt - preAmt;
    if (diff !== 0) {
      tokenChanges.push({
        accountIndex: post.accountIndex,
        mint: post.mint,
        diff,
        diffUi: diff / Math.pow(10, post.uiTokenAmount?.decimals || 6),
        decimals: post.uiTokenAmount?.decimals || 6,
      });
    }
  }

  const fromWallet = solChanges.find(s => s.diff < 0);
  const toWallet = solChanges.find(s => s.diff > 0);

  const tokenIn = tokenChanges.find(t => t.diff < 0);
  const tokenOut = tokenChanges.find(t => t.diff > 0);

  if (fromWallet && tokenOut && tokenOut.mint !== SOL_MINT) {
    return { action: 'buy', tokenMint: tokenOut.mint, solSpent: Math.abs(fromWallet.diff), tokenAmount: tokenOut.diffUi, decimals: tokenOut.decimals };
  }

  if (tokenIn && tokenIn.mint !== SOL_MINT && toWallet) {
    return { action: 'sell', tokenMint: tokenIn.mint, solReceived: toWallet.diff, tokenAmount: Math.abs(tokenIn.diffUi), decimals: tokenIn.decimals };
  }

  if (fromWallet && tokenOut && tokenOut.mint === SOL_MINT) {
    const otherToken = tokenChanges.find(t => t.mint !== SOL_MINT && t.diff > 0);
    if (otherToken) {
      return { action: 'buy', tokenMint: otherToken.mint, solSpent: Math.abs(fromWallet.diff), tokenAmount: otherToken.diffUi, decimals: otherToken.decimals };
    }
  }

  if (tokenIn && tokenIn.mint === SOL_MINT && toWallet) {
    const otherToken = tokenChanges.find(t => t.mint !== SOL_MINT && t.diff < 0);
    if (otherToken) {
      return { action: 'sell', tokenMint: otherToken.mint, solReceived: toWallet.diff, tokenAmount: Math.abs(otherToken.diffUi), decimals: otherToken.decimals };
    }
  }

  if (tokenIn && tokenOut && tokenIn.mint !== SOL_MINT && tokenOut.mint !== SOL_MINT) {
    return { action: 'swap', tokenIn: tokenIn.mint, tokenOut: tokenOut.mint, amountIn: Math.abs(tokenIn.diffUi), amountOut: tokenOut.diffUi };
  }

  if (fromWallet && toWallet && fromWallet.index !== toWallet.index) {
    return { action: 'sol_transfer', amount: Math.abs(fromWallet.diff), from: accounts[fromWallet.index], to: accounts[toWallet.index] };
  }

  return null;
}

function decodeTransaction(tx) {
  try {
    const meta = tx.meta;
    if (!meta || meta.err) return null;

    const txMsg = tx.transaction?.message;
    if (!txMsg) return null;

    const accounts = txMsg.accountKeys?.map(k => (typeof k === 'string' ? k : k.pubkey?.toString() || k.toString())) || [];

    const preBalances = meta.preBalances || [];
    const postBalances = meta.postBalances || [];
    const preTokenBalances = meta.preTokenBalances || [];
    const postTokenBalances = meta.postTokenBalances || [];

    const instructions = txMsg.instructions || [];
    const innerInstructions = meta.innerInstructions || [];

    const allIxs = [...instructions];
    for (const inner of innerInstructions) {
      if (inner.instructions) allIxs.push(...inner.instructions);
    }

    let detectedProgram = null;
    for (const ix of allIxs) {
      const progId = typeof ix.programId === 'string' ? ix.programId : accounts[ix.programIdIndex] || accounts[ix.programId] || null;
      if (progId && KNOWN_PROGRAMS[progId]) {
        detectedProgram = KNOWN_PROGRAMS[progId];
        break;
      }
    }

    const swapInfo = findTokenTransferAccounts(accounts, postBalances, preBalances, postTokenBalances, preTokenBalances);
    if (!swapInfo) return null;

    const sig = tx.transaction?.signatures?.[0] || '';

    return {
      signature: sig,
      slot: tx.slot,
      timestamp: tx.blockTime ? new Date(tx.blockTime * 1000) : new Date(),
      program: detectedProgram || 'unknown',
      ...swapInfo,
    };
  } catch (e) {
    console.error('[TxDecoder] Error:', e.message);
    return null;
  }
}

module.exports = { decodeTransaction, PUMP_PROGRAM, SOL_MINT };
