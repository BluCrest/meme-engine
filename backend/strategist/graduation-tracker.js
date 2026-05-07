const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../config');

const connection = new Connection(config.helius.rpcUrl, 'confirmed');
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const GRADUATION_TARGET_SOL = 85; // Pump.fun graduation threshold

// Find bonding curve PDA for a token
function findBondingCurvePDA(tokenMint) {
  // Pump.fun bonding curve PDA derivation
  // Actual formula: PDA derived from ["bonding-curve", token mint]
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(tokenMint).toBuffer()],
    new PublicKey(PUMP_FUN_PROGRAM)
  );
  return bondingCurve;
}

async function getBondingCurveProgress(tokenAddress) {
  try {
    // Get bonding curve account
    const bondingCurve = findBondingCurvePDA(tokenAddress);
    const accountInfo = await connection.getAccountInfo(bondingCurve);

    if (!accountInfo) {
      // Token might have graduated already
      return {
        progress: 100,
        graduationSignal: 'graduated',
        currentSol: GRADUATION_TARGET_SOL,
        targetSol: GRADUATION_TARGET_SOL,
        isGraduated: true
      };
    }

    // Parse bonding curve data to get SOL balance
    // Pump.fun bonding curve stores SOL balance in the account
    const currentSol = accountInfo.lamports / 1e9; // Convert lamports to SOL
    const progress = Math.min(100, (currentSol / GRADUATION_TARGET_SOL) * 100);

    const graduationSignal =
      progress >= 95 ? 'graduating_now' :
      progress >= 80 ? 'close_to_grad' :
      progress >= 60 ? 'approaching' : 'early';

    return {
      progress: Math.round(progress * 100) / 100,
      graduationSignal,
      currentSol,
      targetSol: GRADUATION_TARGET_SOL,
      isGraduated: progress >= 100
    };
  } catch (err) {
    console.error('[GradTracker] Error:', err.message);
    return {
      progress: 0,
      graduationSignal: 'unknown',
      currentSol: 0,
      targetSol: GRADUATION_TARGET_SOL,
      isGraduated: false
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

module.exports = { getBondingCurveProgress, monitorGraduation };