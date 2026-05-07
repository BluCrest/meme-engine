const { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const crypto = require('crypto');
const config = require('../config');

const connection = new Connection(config.helius.rpcUrl, 'confirmed');
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FEE_RECIPIENT = new PublicKey('D4Cyrh8A6To6oRLkU5s3nWEMqCnzVnJYbwMxkzWEfFgc');
const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111');

function getDiscriminator(sig) {
  return Buffer.from(crypto.createHash('sha256').update(sig).digest().slice(0, 8));
}

const BUY_DISCRIMINATOR = getDiscriminator('global:buy');
const SELL_DISCRIMINATOR = getDiscriminator('global:sell');

function findBondingCurvePDA(tokenMint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(tokenMint).toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function findBondingCurveATA(bondingCurve, tokenMint) {
  return getAssociatedTokenAddressSync(
    new PublicKey(tokenMint),
    bondingCurve,
    true  // allowOwnerOffCurve
  );
}

async function getOrCreateUserATA(userPubkey, tokenMint) {
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(tokenMint),
    userPubkey
  );
  const accountInfo = await connection.getAccountInfo(ata);
  if (accountInfo) return ata; // already exists

  // Need to create it — return null and caller should create it
  return null;
}

function createATAInstruction(userPubkey, tokenMint) {
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(tokenMint),
    userPubkey
  );
  return createAssociatedTokenAccountInstruction(
    userPubkey,  // payer
    ata,         // ata
    userPubkey,  // owner
    new PublicKey(tokenMint)  // mint
  );
}

async function isOnBondingCurve(tokenMint) {
  try {
    const bondingCurve = findBondingCurvePDA(tokenMint);
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    return !!accountInfo; // if account exists, it's on bonding curve
  } catch (_) { return false; }
}

// Buy token through Pump.fun bonding curve
async function pumpBuy(userKeypair, tokenMint, solAmount) {
  const userPubkey = userKeypair.publicKey;
  const mintPubkey = new PublicKey(tokenMint);
  const lamports = Math.floor(solAmount * 1e9);

  const bondingCurve = findBondingCurvePDA(tokenMint);
  const bondingCurveATA = findBondingCurveATA(bondingCurve, tokenMint);
  const userATA = getAssociatedTokenAddressSync(mintPubkey, userPubkey);

  // Check if user ATA exists, create if not
  const tx = new Transaction();
  const ataExists = await connection.getAccountInfo(userATA);
  if (!ataExists) {
    tx.add(createATAInstruction(userPubkey, tokenMint));
  }

  // Calculate token amount: for bonding curve, we use the curve formula
  // Pump.fun uses a bonding curve where:
  // - virtual_sol_reserves starts at 30 SOL
  // - virtual_token_reserves starts at 1,073,000,000 tokens (1.073B)
  // - token_amount = total_supply * (1 - (virtual_sol_reserves / (virtual_sol_reserves + sol_in)))
  // But we'll just ask for a large amount and max_sol_cost limits the spend

  // The buy instruction: amount = max tokens, max_sol_cost = max SOL to spend
  const tokenAmount = new BN('1000000000000'); // ask for 1M tokens (will get less based on curve)
  const maxSolCost = new BN(lamports);

  const data = Buffer.concat([
    BUY_DISCRIMINATOR,
    toBufferLE(tokenAmount, 8),
    toBufferLE(maxSolCost, 8)
  ]);

  tx.add(new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mintPubkey, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveATA, isSigner: false, isWritable: true },
      { pubkey: userATA, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    ],
    data
  }));

  tx.feePayer = userPubkey;
  tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;

  const sig = await connection.sendTransaction(tx, [userKeypair], { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');
  return { signature: sig, tx };
}

// Sell token through Pump.fun bonding curve
async function pumpSell(userKeypair, tokenMint, tokenAmount) {
  const userPubkey = userKeypair.publicKey;
  const mintPubkey = new PublicKey(tokenMint);

  const bondingCurve = findBondingCurvePDA(tokenMint);
  const bondingCurveATA = findBondingCurveATA(bondingCurve, tokenMint);
  const userATA = getAssociatedTokenAddressSync(mintPubkey, userPubkey);
  const tokenAmt = Math.floor(tokenAmount * 1e6);

  const data = Buffer.concat([
    SELL_DISCRIMINATOR,
    toBufferLE(new BN(tokenAmt), 8),
    toBufferLE(new BN(0), 8) // min return = 0 (accept any return)
  ]);

  const tx = new Transaction();
  tx.add(new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: mintPubkey, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveATA, isSigner: false, isWritable: true },
      { pubkey: userATA, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    ],
    data
  }));

  tx.feePayer = userPubkey;
  tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;

  const sig = await connection.sendTransaction(tx, [userKeypair], { maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');
  return { signature: sig, tx };
}

// Big number helper — handles BN objects and BigInt
function toBufferLE(num, bytes) {
  const buf = Buffer.alloc(bytes);
  let n;
  if (typeof num === 'object' && num !== null && 'val' in num) {
    n = BigInt(num.val);
  } else {
    n = BigInt(num);
  }
  for (let i = 0; i < bytes; i++) {
    buf[i] = Number(n & BigInt(0xff));
    n >>= BigInt(8);
  }
  return buf;
}

// BN-like helper using BigInt
class BN {
  constructor(val) { this.val = BigInt(val); }
  toString() { return this.val.toString(); }
  toNumber() { return Number(this.val); }
  valueOf() { return this.val; }
}

module.exports = { pumpBuy, pumpSell, isOnBondingCurve, findBondingCurvePDA };
