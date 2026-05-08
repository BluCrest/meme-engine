const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../config');
const { getTopHolders, getTotalSupply } = require('../utils/holders');

const connection = new Connection(config.helius.rpcUrl, 'confirmed');

const { checkMintAuthority, checkLiquidityLock, simulateSell } = require('./safety-utils');

async function runSafetyCheck(tokenAddress) {
  const checks = {
    honeypot: false,
    liquidityLocked: false,
    liquidityLockDuration: 0,
    ownershipRenounced: false,
    top5Concentration: 0,
    safetyScore: 0,
    riskCategory: 'unknown'
  };

  try {
    // 1. Check ownership via token mint authority
    checks.ownershipRenounced = await checkMintAuthority(tokenAddress);

    // 2. Check liquidity lock
    const lpLockInfo = await checkLiquidityLock(tokenAddress);
    checks.liquidityLocked = lpLockInfo.locked;
    checks.liquidityLockDuration = lpLockInfo.durationHours;

    // 3. Wallet concentration — top 5 holders
    const holders = await getTopHolders(tokenAddress, 5);
    const totalSupply = await getTotalSupply(tokenAddress);
    checks.top5Concentration = totalSupply > 0
      ? holders.reduce((sum, h) => sum + h.balance, 0) / totalSupply * 100
      : 0;

    // 4. Honeypot simulation
    checks.honeypot = await simulateSell(tokenAddress);

    // 5. Compute safety score
    let score = 100;
    if (!checks.ownershipRenounced) score -= 30;
    if (!checks.liquidityLocked) score -= 25;
    // Bonding curve tokens have no LP (duration=0) — don't penalize
    if (checks.liquidityLocked && checks.liquidityLockDuration < 24) score -= 10;
    if (checks.top5Concentration > 50) score -= 20;
    if (checks.honeypot) score = 0;  // instant disqualify

    checks.safetyScore = Math.max(0, score);
    checks.riskCategory =
      score < 40 ? 'rug_likely' :
      score < 70 ? 'risky' : 'relatively_safe';

  } catch (err) {
    console.error('[Safety] Error:', err.message);
  }

  return checks;
}



module.exports = { runSafetyCheck };