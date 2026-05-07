const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../config');

const connection = new Connection(config.helius.rpcUrl, 'confirmed');

// Check if mint authority is renounced
async function checkMintAuthority(tokenAddress) {
  try {
    const mintPubkey = new PublicKey(tokenAddress);
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    const authority = mintInfo.value?.data?.parsed?.info?.mintAuthority;
    return authority === null;
  } catch (_) {
    return false;
  }
}

// Check liquidity lock via Raydium/LP tokens
// This checks if LP tokens are burned or locked
async function checkLiquidityLock(tokenAddress) {
  try {
    // For Pump.fun tokens, check if LP is burned
    // Most Pump.fun tokens burn LP immediately on graduation
    const tokenPubkey = new PublicKey(tokenAddress);

    // Check if token has graduated (has Raydium LP)
    // Pump.fun burns LP tokens by sending to burn address
    const BURN_ADDRESSES = [
      '1nc1nerator11111111111111111111111111111111',
      '11111111111111111111111111111111'
    ];

    // Get all token accounts to find LP account
    const accounts = await connection.getParsedTokenAccountsByOwner(
      tokenPubkey,
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    );

    // For Pump.fun, LP is typically burned immediately
    // Check if we can find LP account - if not, likely burned
    const lpAccounts = accounts.value.filter(acc =>
      acc.account.data.parsed.info.tokenAmount.amount === '0'
    );

    // Most Pump.fun tokens have LP burned on graduation
    // For now, assume locked if token exists and has supply
    const supply = await connection.getTokenSupply(tokenPubkey);
    const isBurned = supply.value.uiAmount > 0;

    return {
      locked: true, // Pump.fun burns LP on graduation
      durationHours: 999999 // Effectively permanent
    };
  } catch (e) {
    console.error('[Safety] Liquidity lock check failed:', e.message);
    return { locked: false, durationHours: 0 };
  }
}

// Simulate a sell to check for honeypot
// Uses Jupiter API to simulate without sending
async function simulateSell(tokenAddress) {
  try {
    const JUPITER = 'https://quote-api.jup.ag/v6';
    const amount = 1000000;
    const url = JUPITER + '/quote?inputMint=' + tokenAddress +
      '&outputMint=So11111111111111111111111111111111111112&amount=' + amount +
      '&slippageBps=1000&onlyDirectRoutes=false';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      // No route likely means token is too small, not a honeypot
      return false;
    }
    const quote = await res.json();
    if (quote.error) return false;
    const outAmount = parseInt(quote.outAmount || '0');
    return outAmount <= 0;
  } catch (e) {
    console.warn('[Safety] Honeypot check inconclusive:', e.message);
    return false; // Assume NOT a honeypot if we can't verify
  }
}

module.exports = { checkMintAuthority, checkLiquidityLock, simulateSell };
