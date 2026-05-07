const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const config = require('../config');
const db = require('../database/db');
const { getCurrentPrice, getCurrentMC } = require('../utils/price-feed');

const connection = new Connection(config.helius.rpcUrl, 'confirmed');
const JUPITER_API = 'https://quote-api.jup.ag/v6';
const SOL_MINT = 'So11111111111111111111111111111111111112';

let walletKeypair;
try {
  const arr = JSON.parse(config.helius.privateKey || '[]');
  if (arr.length > 0) {
    walletKeypair = Keypair.fromSecretKey(new Uint8Array(arr));
    console.log('[Executor] Wallet loaded');
  }
} catch (e) {
  console.error('[Executor] Wallet init failed:', e.message);
}

async function getBalance() {
  if (!walletKeypair) return 0;
  const bal = await connection.getBalance(walletKeypair.publicKey);
  return bal / LAMPORTS_PER_SOL;
}

async function getJupiterQuote(input, output, amount, slippageBps) {
  slippageBps = slippageBps || 300;
  const url = JUPITER_API + '/quote?inputMint=' + input + '&outputMint=' + output + '&amount=' + amount + '&slippageBps=' + slippageBps + '&onlyDirectRoutes=false';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Jupiter quote failed: ' + res.statusText);
  return res.json();
}

async function executeJupiterSwap(quoteResp, userPk) {
  const body = JSON.stringify({
    quoteResponse: quoteResp,
    userPublicKey: userPk.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto'
  });
  const res = await fetch(JUPITER_API + '/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body
  });
  if (!res.ok) throw new Error('Jupiter swap failed: ' + res.statusText);
  return res.json();
}

async function executeBuy(tokenAddr, mode, amountSol) {
  mode = mode || 'manual_confirm';
  amountSol = amountSol || config.config.maxSolPerTrade;
  const MIN_BUY = 0.001; // Minimum buy amount
  const GAS_RESERVE = 0.01; // Keep for gas fees

  try {
    if (!walletKeypair) throw new Error('Wallet not initialized');
    let bal = await getBalance();

    // Scale down if balance is low
    if (bal < amountSol + GAS_RESERVE) {
      const scaledAmount = (bal - GAS_RESERVE) / 4; // Divide by 4 to be safe
      amountSol = Math.max(scaledAmount, MIN_BUY);
      console.log(`[Executor] Scaled buy to ${amountSol} SOL (balance: ${bal})`);
    }

    if (bal < amountSol + GAS_RESERVE) throw new Error('Insufficient balance for buy + gas: ' + bal + ' SOL');
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const quote = await getJupiterQuote(SOL_MINT, tokenAddr, lamports);
    if (!quote || quote.error) throw new Error('No route: ' + (quote?.error || 'Unknown'));
    const swapRes = await executeJupiterSwap(quote, walletKeypair.publicKey);
    const buf = Buffer.from(swapRes.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([walletKeypair]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    const conf = await connection.confirmTransaction(sig, 'confirmed');
    if (conf.value.err) throw new Error('TX failed: ' + JSON.stringify(conf.value.err));
    const tokenAmt = parseInt(quote.outAmount) / 1e6;
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
      tokenAddress: tokenAddr,
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
    console.error('[Executor] Buy failed:', e.message);
    return { success: false, error: e.message };
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
    const quote = await getJupiterQuote(tokenAddr, SOL_MINT, Math.floor(sellAmt * 1e6), 500);
    if (!quote || quote.error) throw new Error('No sell route: ' + (quote?.error || 'Unknown'));
    const swapRes = await executeJupiterSwap(quote, walletKeypair.publicKey);
    const buf = Buffer.from(swapRes.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([walletKeypair]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');
    const price = await getCurrentPrice(tokenAddr);
    const mc = await getCurrentMC(tokenAddr);
    const solVal = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
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
    const newRatio = pos.remaining_ratio - sellRatio;
    if (newRatio <= 0.01) {
      await db.getDb().collection('positions').updateOne(
        { token_address: tokenAddr },
        { $set: { status: 'closed', closed_at: new Date(), remaining_ratio: 0 } }
      );
    } else {
      await db.getDb().collection('positions').updateOne(
        { token_address: tokenAddr },
        { $set: { remaining_ratio: newRatio } }
      );
    }
    const retMult = pos.entry_price > 0 ? price / pos.entry_price : 0;
    const pnlPercent = (retMult - 1) * 100;
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
