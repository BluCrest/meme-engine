const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');
const config = require('../config');
const db = require('../database/db');
const { getCurrentPrice, getCurrentMC } = require('../utils/price-feed');

const connection = new Connection(config.helius.rpcUrl, 'confirmed');
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111112';

let walletKeypair;
const pk = config.helius?.privateKey;
if (pk) {
  try {
    const decoded = bs58.decode(pk);
    walletKeypair = Keypair.fromSecretKey(new Uint8Array(decoded));
    console.log('[Executor] Wallet loaded from base58 key');
  } catch (e) {
    try {
      const arr = JSON.parse(pk);
      if (arr.length > 0) {
        walletKeypair = Keypair.fromSecretKey(new Uint8Array(arr));
        console.log('[Executor] Wallet loaded from JSON array');
      }
    } catch (e2) {
      console.error('[Executor] Wallet init failed — key must be base58 or JSON array');
    }
  }
}

async function getBalance() {
  if (!walletKeypair) return 0;
  const bal = await connection.getBalance(walletKeypair.publicKey);
  return bal / LAMPORTS_PER_SOL;
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function getJupiterQuote(input, output, amount, slippageBps) {
  slippageBps = slippageBps || 300;
  const endpoints = [
    { base: 'https://quote-api.jup.ag/v6', path: '/quote', params: '&onlyDirectRoutes=false' },
    { base: 'https://api.jup.ag/swap/v1', path: '/quote', params: '' },
    { base: 'https://api.jup.ag/v6', path: '/quote', params: '&onlyDirectRoutes=false' }
  ];
  let lastErr;
  for (const { base, path, params } of endpoints) {
    try {
      const url = `${base}${path}?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=${slippageBps}${params}`;
      const res = await fetchWithTimeout(url, {}, 10000);
      if (!res.ok) { lastErr = new Error(`Jupiter ${res.status}`); continue; }
      const data = await res.json();
      if (!data || data.error) { lastErr = new Error('Jupiter no route'); continue; }
      return data;
    } catch (e) { lastErr = e; }
  }
  // If all failed, token likely has no route — not an error for micro-caps
  console.log(`[Executor] No Jupiter route for ${input.slice(0, 8)}... (expected for micro-caps)`);
  return null;
}

async function executeJupiterSwap(quoteResp, userPk) {
  const endpoints = [
    { base: 'https://api.jup.ag/swap/v1', path: '/swap' },
    { base: 'https://quote-api.jup.ag/v6', path: '/swap' },
    { base: 'https://api.jup.ag/v6', path: '/swap' }
  ];
  let lastErr;
  for (const { base, path } of endpoints) {
    try {
      const body = JSON.stringify({
        quoteResponse: quoteResp,
        userPublicKey: userPk.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      });
      const res = await fetchWithTimeout(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body
      }, 15000);
      if (!res.ok) { lastErr = new Error(`Jupiter swap ${res.status} ${path}`); continue; }
      return res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Jupiter swap failed');
}

async function executeBuy(tokenAddr, mode, amountSol) {
  mode = mode || 'manual_confirm';
  amountSol = amountSol || config.config.maxSolPerTrade;
  const MIN_BUY = 0.002;
  const GAS_RESERVE = 0.01;

  try {
    if (!walletKeypair) throw new Error('Wallet not initialized');
    let bal = await getBalance();

    if (bal < amountSol + GAS_RESERVE) {
      const scaledAmount = (bal - GAS_RESERVE) / 4;
      amountSol = Math.max(scaledAmount, MIN_BUY);
      console.log(`[Executor] Scaled buy to ${amountSol.toFixed(6)} SOL (balance: ${bal.toFixed(6)})`);
    }

    if (amountSol < MIN_BUY) throw new Error('Balance too low: ' + bal.toFixed(4) + ' SOL');

    let sig, tokenAmt;
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    // Paper trading: skip real swap execution
    if (config.paperTrading) {
      sig = 'paper_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      tokenAmt = lamports / 1e9 / 0.0001; // simulate token amount at ~0.0001 SOL/token
      console.log(`[Executor] PAPER buy: ${amountSol} SOL → ${tokenAddr} (sig: ${sig})`);
    } else {
    // Strategy 1: Try Jupiter (works for listed tokens)
    const quote = await getJupiterQuote(SOL_MINT, tokenAddr, lamports);
    if (quote && !quote.error) {
      const swapRes = await executeJupiterSwap(quote, walletKeypair.publicKey);
      const buf = Buffer.from(swapRes.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(buf);
      tx.sign([walletKeypair]);
      sig = await connection.sendTransaction(tx, { maxRetries: 3 });
      const conf = await connection.confirmTransaction(sig, 'confirmed');
      if (conf.value.err) throw new Error('TX failed: ' + JSON.stringify(conf.value.err));
      tokenAmt = parseInt(quote.outAmount) / 1e6;
      console.log(`[Executor] Jupiter buy: ${sig}`);
    } else {
      // Strategy 2: Try Pump.fun bonding curve (for pre-graduation tokens)
      const { pumpBuy, isOnBondingCurve } = require('../utils/pump-swap');
      const onCurve = await isOnBondingCurve(tokenAddr);
      if (!onCurve) throw new Error('No route (Jupiter + Pump.fun both unavailable)');
      const result = await pumpBuy(walletKeypair, tokenAddr, amountSol);
      sig = result.signature;
      tokenAmt = amountSol / 0.0001; // rough estimate (actual amount from event)
      console.log(`[Executor] Pump.fun buy: ${sig}`);
    }
    }
    const price = await getCurrentPrice(tokenAddr);
    const mc = await getCurrentMC(tokenAddr);
    const trade = {
      token_address: tokenAddr,
      action: 'buy',
      sol_amount: amountSol,
      token_amount: tokenAmt,
      price_at_trade: price,
      mc_at_trade: mc,
      tx_signature: sig,
      mode: mode,
      triggered_by: mode,
      timestamp: new Date()
    };
    await db.insertTrade(trade);
    await db.upsertPosition({
      token_address: tokenAddr,
      entry_price: price,
      entry_mc: mc,
      sol_invested: amountSol,
      remaining_ratio: 1.0,
      highest_price: price,
      status: 'open',
      opened_at: new Date(),
      dev_wallet: await getDevWalletFromDB(tokenAddr)
    });
    console.log('[Executor] Buy executed:', sig);

    // Send buy notification
    const { sendTradeNotification } = require('./telegram-bot');
    await sendTradeNotification({ symbol: trade.symbol, address: tokenAddr, price }, 'buy', amountSol);

    return { success: true, signature: sig, trade: trade };
  } catch (e) {
    console.error('[Executor] Buy failed:', e?.message || e, e?.stack ? '\n' + e.stack : '');
    return { success: false, error: e?.message || String(e) };
  }
}

async function executeSell(tokenAddr, sellRatio, reason) {
  sellRatio = sellRatio || 1.0;
  reason = reason || 'manual';
  try {
    if (!walletKeypair) throw new Error('Wallet not initialized');
    const pos = await db.getDb().collection('positions').findOne({
      token_address: tokenAddr,
      status: 'open'
    });
    if (!pos) throw new Error('No open position');
    const ata = await getAssociatedTokenAddress(new PublicKey(tokenAddr), walletKeypair.publicKey);
    let bal = 0;
    try {
      const acc = await getAccount(connection, ata);
      bal = Number(acc.amount) / 1e6;
    } catch (e) {
      throw new Error('No token balance');
    }
    const sellAmt = bal * sellRatio;
    if (sellAmt <= 0) throw new Error('Nothing to sell');
    const sellLamports = Math.floor(sellAmt * 1e6);
    let sig, solVal;

    // Paper trading: skip real swap execution
    if (config.paperTrading) {
      sig = 'paper_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      solVal = sellAmt * 0.0001 * 180; // simulate SOL return
      console.log(`[Executor] PAPER sell: ${sellAmt} tokens → ${solVal.toFixed(6)} SOL (sig: ${sig})`);
    } else {
    const quote = await getJupiterQuote(tokenAddr, SOL_MINT, sellLamports, 500);
    if (quote && !quote.error) {
      const swapRes = await executeJupiterSwap(quote, walletKeypair.publicKey);
      const buf = Buffer.from(swapRes.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(buf);
      tx.sign([walletKeypair]);
      sig = await connection.sendTransaction(tx, { maxRetries: 3 });
      await connection.confirmTransaction(sig, 'confirmed');
      solVal = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    } else {
      // Try Pump.fun sell
      const { pumpSell, isOnBondingCurve } = require('../utils/pump-swap');
      const onCurve = await isOnBondingCurve(tokenAddr);
      if (!onCurve) throw new Error('No sell route');
      const result = await pumpSell(walletKeypair, tokenAddr, sellAmt);
      sig = result.signature;
      solVal = sellAmt * 0.9; // rough estimate after fees
    }
    }
    const price = await getCurrentPrice(tokenAddr);
    const mc = await getCurrentMC(tokenAddr);
    const trade = {
      token_address: tokenAddr,
      action: 'sell',
      sol_amount: solVal,
      token_amount: sellAmt,
      price_at_trade: price,
      mc_at_trade: mc,
      tx_signature: sig,
      mode: 'auto',
      triggered_by: reason,
      timestamp: new Date()
    };
    await db.insertTrade(trade);
    const retMult = pos.entry_price > 0 ? price / pos.entry_price : 0;
    const pnlPercent = (retMult - 1) * 100;
    const newRatio = pos.remaining_ratio - sellRatio;
    if (newRatio <= 0.01) {
      await db.getDb().collection('positions').updateOne(
        { token_address: tokenAddr },
        { $set: { status: 'closed', closed_at: new Date(), remaining_ratio: 0 } }
      );
      // Record outcome for agent learning
      try {
        const patternMemory = require('../agents/pattern-memory');
        await patternMemory.recordTradeOutcome(tokenAddr, pnlPercent, retMult);
        const adaptiveWeights = require('../agents/adaptive-weights');
        const tokenRec = await db.getToken(tokenAddr);
        await adaptiveWeights.recordResult(tokenAddr, tokenRec?.ape_probability || 0, pnlPercent);
      } catch (_) {}
    } else {
      await db.getDb().collection('positions').updateOne(
        { token_address: tokenAddr },
        { $set: { remaining_ratio: newRatio } }
      );
    }
    const outcome = retMult > 1 ? 'win' : retMult < 0.5 ? 'loss' : 'neutral';
    await db.getDb().collection('intelligence_reports').insertOne({
      token_address: tokenAddr,
      symbol: (await db.getToken(tokenAddr))?.symbol,
      entry_mc: pos.entry_mc,
      exit_mc: mc,
      return_multiple: retMult,
      outcome: outcome,
      notes: 'Sold ' + (sellRatio * 100).toFixed(0) + '% due to ' + reason,
      timestamp: new Date()
    });
    console.log('[Executor] Sell executed:', sig);

    // Send sell notification
    const { sendTradeNotification } = require('./telegram-bot');
    const tokenInfo = await db.getToken(tokenAddr);
    await sendTradeNotification(
      { symbol: tokenInfo?.symbol, address: tokenAddr, price },
      'sell',
      solVal,
      pnlPercent
    );

    return { success: true, signature: sig, trade: trade };
  } catch (e) {
    console.error('[Executor] Sell failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function getDevWalletFromDB(tokenAddr) {
  const t = await db.getToken(tokenAddr);
  return t?.dev_wallet || null;
}

module.exports = { executeBuy, executeSell, getBalance, walletKeypair };
