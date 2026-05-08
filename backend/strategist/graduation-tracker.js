const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../config');
const db = require('../database/db');
const { executeWithFallback } = require('../utils/rpc-rotator');

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const GRADUATION_TARGET_SOL = 85; // Pump.fun graduation threshold

function findBondingCurvePDA(tokenMint) {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(tokenMint).toBuffer()],
    new PublicKey(PUMP_FUN_PROGRAM)
  );
  return bondingCurve;
}

async function getBondingCurveSOL(tokenAddress) {
  const bondingCurve = findBondingCurvePDA(tokenAddress);
  const accountInfo = await executeWithFallback(conn => conn.getAccountInfo(bondingCurve));
  if (!accountInfo) return null;
  return accountInfo.lamports / 1e9;
}

async function recordCurveSnapshot(tokenAddress) {
  const currentSol = await getBondingCurveSOL(tokenAddress);
  if (currentSol === null) return null;
  const snapshot = { token_address: tokenAddress, sol: currentSol, timestamp: new Date() };
  await db.getDb().collection('curve_snapshots').insertOne(snapshot);
  return snapshot;
}

async function getCurveVelocity(tokenAddress) {
  const snapshots = await db.getDb().collection('curve_snapshots')
    .find({ token_address: tokenAddress })
    .sort({ timestamp: -1 })
    .limit(2)
    .toArray();
  if (snapshots.length < 2) return null;
  const latest = snapshots[0];
  const prev = snapshots[1];
  const elapsed = (latest.timestamp - prev.timestamp) / 60000;
  if (elapsed <= 0) return null;
  return {
    velocitySolPerMin: (latest.sol - prev.sol) / elapsed,
    currentSol: latest.sol,
    dSol: latest.sol - prev.sol,
    elapsedMinutes: elapsed
  };
}

async function getBondingCurveProgress(tokenAddress) {
  try {
    const currentSol = await getBondingCurveSOL(tokenAddress);

    if (currentSol === null) {
      return {
        progress: 100,
        graduationSignal: 'graduated',
        currentSol: GRADUATION_TARGET_SOL,
        targetSol: GRADUATION_TARGET_SOL,
        isGraduated: true,
        velocity: null
      };
    }

    const progress = Math.min(100, (currentSol / GRADUATION_TARGET_SOL) * 100);
    const velocity = await getCurveVelocity(tokenAddress);

    const graduationSignal =
      progress >= 95 ? 'graduating_now' :
      progress >= 80 ? 'close_to_grad' :
      progress >= 60 ? 'approaching' : 'early';

    return {
      progress: Math.round(progress * 100) / 100,
      graduationSignal,
      currentSol,
      targetSol: GRADUATION_TARGET_SOL,
      isGraduated: progress >= 100,
      velocity
    };
  } catch (err) {
    console.error('[GradTracker] Error:', err.message);
    return {
      progress: 0,
      graduationSignal: 'unknown',
      currentSol: 0,
      targetSol: GRADUATION_TARGET_SOL,
      isGraduated: false,
      velocity: null
    };
  }
}

async function monitorGraduation(tokenAddress, callback) {
  const check = async () => {
    const status = await getBondingCurveProgress(tokenAddress);

    if (status.isGraduated) {
      console.log(`[GradTracker] ${tokenAddress} has graduated!`);
      if (callback) callback('graduated', status);
      return true; // Stop monitoring
    }

    if (status.progress >= 80 && status.progress < 95) {
      console.log(`[GradTracker] ${tokenAddress} close to graduation: ${status.progress}%`);
      if (callback) callback('close_to_grad', status);
    }

    return false;
  };

  const done = await check();
  if (!done) {
    const interval = setInterval(async () => {
      const done = await check();
      if (done) clearInterval(interval);
    }, 60000); // Check every minute
  }
}

module.exports = { getBondingCurveProgress, monitorGraduation, recordCurveSnapshot };