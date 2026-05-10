const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { executeWithFallback, getConnection } = require('./rpc-rotator');
const crypto = require('crypto');
const config = require('../config');

// RPC connection with automatic fallback on rate limits
function getConn() { return getConnection(); }
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

// ── PDAs ──────────────────────────────────────────────────────

function findBondingCurvePDA(tokenMint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(tokenMint).toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function findBondingCurveATA(bondingCurve, tokenMint) {
  return getAssociatedTokenAddressSync(new PublicKey(tokenMint), bondingCurve, true);
}

function findGlobalPDA() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP_PROGRAM_ID);
  return pda;
}

function findEventAuthorityPDA() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM_ID);
  return pda;
}

function findGlobalVolumeAccumulatorPDA() {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('global_volume_accumulator')], PUMP_PROGRAM_ID);
  return pda;
}

function findUserVolumeAccumulatorPDA(user) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function findCreatorVaultPDA(creator) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

function findFeeConfigPDA() {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config')],
    PUMP_FEE_PROGRAM_ID
  );
  return pda;
}

// ── Bonding curve data parsing ────────────────────────────────

function parseCreatorFromBondingCurve(accountInfo) {
  // BondingCurve layout (81 bytes):
  //   0..8    discriminator (u64)
  //   8..16   virtualTokenReserves (u64)
  //  16..24   virtualSolReserves (u64)
  //  24..32   realTokenReserves (u64)
  //  32..40   realSolReserves (u64)
  //  40..48   tokenTotalSupply (u64)
  //  48       complete (bool, 1 byte)
  //  49..81   creator (Pubkey, 32 bytes)
  const data = accountInfo.data;
  return new PublicKey(data.slice(49, 81));
}

async function readBondingCurveCreator(tokenMint) {
  const bondingCurve = findBondingCurvePDA(tokenMint);
  const accountInfo = await executeWithFallback(conn => conn.getAccountInfo(bondingCurve));
  if (!accountInfo) return null;
  return parseCreatorFromBondingCurve(accountInfo);
}

// ── Discriminators ────────────────────────────────────────────

function sha256Discriminator(sig) {
  return Buffer.from(crypto.createHash('sha256').update(sig).digest().slice(0, 8));
}

const BUY_EXACT_SOL_IN = sha256Discriminator('global:buy_exact_sol_in'); // 38fc74089edfcd5f
const SELL_DISCRIMINATOR = sha256Discriminator('global:sell');           // 33e685a4017f83ad

// ── Helpers ───────────────────────────────────────────────────

class BN {
  constructor(val) { this.val = BigInt(val); }
  toString() { return this.val.toString(); }
  toNumber() { return Number(this.val); }
  valueOf() { return this.val; }
}

function toBufferLE(num, bytes) {
  const buf = Buffer.alloc(bytes);
  let n;
  if (typeof num === 'object' && num !== null && 'val' in num) n = BigInt(num.val);
  else n = BigInt(num);
  for (let i = 0; i < bytes; i++) {
    buf[i] = Number(n & BigInt(0xff));
    n >>= BigInt(8);
  }
  return buf;
}

async function ensureATA(userKeypair, tokenMint, tx) {
  const mintPubkey = new PublicKey(tokenMint);
  const ata = getAssociatedTokenAddressSync(mintPubkey, userKeypair.publicKey);
  
  // Check if ATA already exists
  const conn = getConn();
  try {
    if (conn) {
      const acc = await conn.getAccountInfo(ata);
      if (acc) {
        console.log(`[PumpSwap] ATA exists: ${ata.toString().slice(0,8)}...`);
        return ata;
      }
    }
  } catch (e) {
    console.log(`[PumpSwap] ATA check error (may not exist): ${e.message}`);
  }
  
  // Use createAssociatedTokenAccountIdempotentInstruction but add proper keys
  // This creates the account if it doesn't exist, initializing it properly
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    userKeypair.publicKey,  // payer
    ata,                    // associated token account address
    userKeypair.publicKey,  // owner
    mintPubkey              // mint
  );
  
  tx.add(createAtaIx);
  console.log(`[PumpSwap] Adding ATA creation instruction: ${ata.toString().slice(0,8)}...`);
  return ata;
}

async function readBuybackFeeRecipient() {
  try {
    const feeConfigPDA = findFeeConfigPDA();
    const acc = await executeWithFallback(conn => conn.getAccountInfo(feeConfigPDA));
    if (!acc || acc.data.length < 72) return null;
    return new PublicKey(acc.data.slice(40, 72));
  } catch { return null; }
}

// ── Public API ────────────────────────────────────────────────

async function isOnBondingCurve(tokenMint) {
  try {
    const bondingCurve = findBondingCurvePDA(tokenMint);
    const ai = await executeWithFallback(conn => conn.getAccountInfo(bondingCurve));
    return !!ai;
  } catch (_) { return false; }
}

// opts: { feeRecipient } — lets caller override for debugging
async function pumpBuy(userKeypair, tokenMint, solAmount, opts = {}) {
  const userPubkey = userKeypair.publicKey;
  const mintPubkey = new PublicKey(tokenMint);
  const lamports = Math.floor(solAmount * 1e9);

  const bondingCurve    = findBondingCurvePDA(tokenMint);
  const bcATA           = findBondingCurveATA(bondingCurve, tokenMint);
  const globalPDA       = findGlobalPDA();
  const eventAuthority  = findEventAuthorityPDA();
  const globalVolAcc    = findGlobalVolumeAccumulatorPDA();
  const userVolAcc      = findUserVolumeAccumulatorPDA(userPubkey);
  const creator         = await readBondingCurveCreator(tokenMint);
  if (!creator) throw new Error('Bonding curve not found — token may have graduated or not exist');
  const creatorVault    = findCreatorVaultPDA(creator);
  const feeConfigPDA    = findFeeConfigPDA();
  const feeRecipient    = opts.feeRecipient || (await readBuybackFeeRecipient()) || new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

  const tx = new Transaction();
  const userATA = await ensureATA(userKeypair, tokenMint, tx);

  // ── Use buy_exact_sol_in (most natural: "spend X SOL, get ≥Y tokens") ──
  // data: discriminator(8) + spendable_sol_in(8) + min_tokens_out(8) + track_volume(1 = None)
  const data = Buffer.concat([
    BUY_EXACT_SOL_IN,
    toBufferLE(new BN(lamports), 8),          // spendable_sol_in — exact SOL to spend
    toBufferLE(new BN(1), 8),                 // min_tokens_out — at least 1 wei
    Buffer.from([0x00]),                       // track_volume: None
  ]);

  const keys = [
    { pubkey: globalPDA,      isSigner: false, isWritable: false },  // 1  global
    { pubkey: feeRecipient,   isSigner: false, isWritable: true  },  // 2  fee_recipient
    { pubkey: mintPubkey,     isSigner: false, isWritable: false },  // 3  mint
    { pubkey: bondingCurve,   isSigner: false, isWritable: true  },  // 4  bonding_curve
    { pubkey: bcATA,          isSigner: false, isWritable: true  },  // 5  associated_bonding_curve
    { pubkey: userATA,        isSigner: false, isWritable: true  },  // 6  associated_user
    { pubkey: userPubkey,     isSigner: true,  isWritable: true  },  // 7  user
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // 8 system_program
    { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false }, // 9 token_program
    { pubkey: creatorVault,   isSigner: false, isWritable: true  },  // 10 creator_vault
    { pubkey: eventAuthority, isSigner: false, isWritable: false },  // 11 event_authority
    { pubkey: PUMP_PROGRAM_ID,   isSigner: false, isWritable: false }, // 12 program
    { pubkey: globalVolAcc,   isSigner: false, isWritable: false },  // 13 global_volume_accumulator (required PDA)
    { pubkey: userVolAcc,     isSigner: false, isWritable: true  },  // 14 user_volume_accumulator (required PDA)
    { pubkey: feeConfigPDA,   isSigner: false, isWritable: false },  // 15 fee_config
    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false }, // 16 fee_program
  ];

  tx.add(new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data }));
  tx.feePayer = userPubkey;
  const conn = getConn();
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

  console.log(`[PumpSwap] Sending buy tx: ${solAmount} SOL for ${tokenMint}`);
  console.log(`[PumpSwap] Keys: ${keys.length}, Program: ${PUMP_PROGRAM_ID.toString()}`);

  try {
    const sig = await conn.sendTransaction(tx, [userKeypair], { maxRetries: 3, preflightCommitment: 'confirmed' });
    await conn.confirmTransaction(sig, 'confirmed');
    return { signature: sig, tx };
  } catch (err) {
    console.error(`[PumpSwap] Buy failed: ${err.message}`);
    throw err;
  }
}

async function pumpSell(userKeypair, tokenMint, tokenAmount) {
  const userPubkey = userKeypair.publicKey;
  const mintPubkey = new PublicKey(tokenMint);
  const tokenAmt   = Math.floor(tokenAmount * 1e6);

  const bondingCurve   = findBondingCurvePDA(tokenMint);
  const bcATA          = findBondingCurveATA(bondingCurve, tokenMint);
  const globalPDA      = findGlobalPDA();
  const eventAuthority = findEventAuthorityPDA();
  const creator        = await readBondingCurveCreator(tokenMint);
  if (!creator) throw new Error('Bonding curve not found for sell');
  const creatorVault   = findCreatorVaultPDA(creator);
  const feeConfigPDA   = findFeeConfigPDA();
  const feeRecipient   = (await readBuybackFeeRecipient()) || new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

  const tx = new Transaction();
  const userATA = await ensureATA(userKeypair, tokenMint, tx);

  const data = Buffer.concat([
    SELL_DISCRIMINATOR,
    toBufferLE(new BN(tokenAmt), 8),  // amount — exact tokens to sell
    toBufferLE(new BN(0), 8),          // min_sol_output — accept any return
  ]);

  // Sell accounts per buy pattern
  const keys = [
    { pubkey: globalPDA,      isSigner: false, isWritable: false },  // 1  global
    { pubkey: feeRecipient,   isSigner: false, isWritable: true  },  // 2  fee_recipient
    { pubkey: mintPubkey,     isSigner: false, isWritable: false },  // 3  mint
    { pubkey: bondingCurve,   isSigner: false, isWritable: true  },  // 4  bonding_curve
    { pubkey: bcATA,          isSigner: false, isWritable: true  },  // 5  associated_bonding_curve
    { pubkey: userATA,        isSigner: false, isWritable: true  },  // 6  associated_user
    { pubkey: userPubkey,     isSigner: true,  isWritable: true  },  // 7  user
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // 8 system_program
    { pubkey: creatorVault,   isSigner: false, isWritable: true  },  // 9  creator_vault
    { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false }, // 10 token_program
    { pubkey: eventAuthority, isSigner: false, isWritable: false },  // 11 event_authority
    { pubkey: PUMP_PROGRAM_ID,   isSigner: false, isWritable: false }, // 12 program
    { pubkey: feeConfigPDA,   isSigner: false, isWritable: false },  // 13 fee_config
    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false }, // 14 fee_program
  ];

  tx.add(new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data }));
  tx.feePayer = userPubkey;
  const conn = getConn();
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

  const sig = await conn.sendTransaction(tx, [userKeypair], { maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  return { signature: sig, tx };
}

module.exports = { pumpBuy, pumpSell, isOnBondingCurve, findBondingCurvePDA };
