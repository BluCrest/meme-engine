const { PublicKey } = require('@solana/web3.js');
const config = require('../config');
const db = require('../database/db');

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const GRADUATION_TARGET_SOL = 85;

const VELOCITY_WINDOWS = {
  '1m': 60000,
  '5m': 300000,
  '15m': 900000
};

function findBondingCurvePDA(tokenMint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(tokenMint).toBuffer()],
    new PublicKey(PUMP_FUN_PROGRAM)
  );
  return pda;
}

async function getBondingCurveSOL(tokenAddress) {
  try {
    const { executeWithFallback } = require('../utils/rpc-rotator');
    const sol = await executeWithFallback(async (conn) => {
      const bondingCurve = findBondingCurvePDA(tokenAddress);
      const accountInfo = await conn.getAccountInfo(bondingCurve);
      if (!accountInfo) return null;
      return accountInfo.lamports / 1e9;
    });
    return sol;
  } catch (err) {
    return null;
  }
}

async function recordSnapshot(tokenAddress) {
  const currentSOL = await getBondingCurveSOL(tokenAddress);
  if (currentSOL === null) return null;

  const snapshot = {
    token_address: tokenAddress,
    sol: currentSOL,
    progress: Math.min(100, (currentSOL / GRADUATION_TARGET_SOL) * 100),
    timestamp: new Date()
  };

  await db.getDb().collection('curve_snapshots').insertOne(snapshot);
  return snapshot;
}

async function computeVelocity(tokenAddress) {
  const snapshots = await db.getDb().collection('curve_snapshots')
    .find({ token_address: tokenAddress })
    .sort({ timestamp: -1 })
    .limit(2)
    .toArray();

  if (snapshots.length < 2) return null;

  const latest = snapshots[0];
  const prev = snapshots[1];
  const elapsed = (latest.timestamp - prev.timestamp) / 60000; // minutes
  if (elapsed <= 0) return null;

  const dSol = latest.sol - prev.sol;
  return {
    velocitySolPerMin: dSol / elapsed,
    currentSol: latest.sol,
    progress: latest.progress,
    timeSinceFirstSnapshot: elapsed,
    dSol
  };
}

async function predictGraduation(tokenAddress) {
  const velocity = await computeVelocity(tokenAddress);
  if (!velocity || velocity.velocitySolPerMin <= 0) {
    return { probability: 'unknown', etaMinutes: null, velocity };
  }

  const remaining = GRADUATION_TARGET_SOL - velocity.currentSol;
  const etaMinutes = remaining > 0 ? remaining / velocity.velocitySolPerMin : 0;

  let probability;
  if (velocity.velocitySolPerMin > 1) probability = 'high';     // >1 SOL/min
  else if (velocity.velocitySolPerMin > 0.3) probability = 'medium';
  else probability = 'low';

  if (velocity.progress >= 85) probability = 'high'; // close anyway

  return { probability, etaMinutes: Math.round(etaMinutes), velocity };
}

module.exports = {
  recordSnapshot,
  computeVelocity,
  predictGraduation,
  getBondingCurveSOL
};
