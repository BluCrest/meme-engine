const config = require('../config');
const db = require('../database/db');
const { computeFinalScore } = require('../strategist/score-engine');
const { sendTokenAlert } = require('../operator/telegram-bot');

// DEX Program IDs to monitor
const DEX_PROGRAMS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNyFb3mnxVb6pZ6EBGiZZj4',
  RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  ORCA: '9W959DqY188ahmGk8L543LrjxK5JR8qZz6mFHjV5Gks',
  METEORA: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6XyZnWr1L2nZ',
  PHOTON: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
};

let lastChecked = Date.now();
const CHECK_INTERVAL = 60000; // Check every minute

// Fetch new tokens from DexScreener (covers ALL DEXes)
async function scanDexScreener() {
  try {
    // Method 1: Token profiles - best for discovering newly created tokens
    const profileRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const profiles = await profileRes.json();

    if (Array.isArray(profiles)) {
      for (const profile of profiles) {
        const tokenAddress = profile.tokenAddress;
        if (!tokenAddress) continue;

        const existing = await db.getToken(tokenAddress);
        if (existing) continue;

        // Fetch pair data to get market cap
        try {
          const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
          const pairData = await pairRes.json();
          const pair = pairData.pairs?.[0];
          if (!pair) continue;

          const mc = pair.fdv || 0;
          if (mc >= 1000000) continue;
          if (mc < 1000) continue; // skip dust

          console.log(`[MultiDEX] New token from profiles: ${pair.baseToken?.symbol} (${tokenAddress}) MC: $${mc}`);

          await db.upsertToken({
            address: tokenAddress,
            symbol: pair.baseToken?.symbol,
            name: pair.baseToken?.name,
            current_mc: mc,
            status: 'new',
            created_at: new Date(),
            dex: pair.dexId
          });

          setTimeout(async () => {
            const result = await computeFinalScore(tokenAddress);
            if (result.shouldAlert) {
              const token = await db.getToken(tokenAddress);
              await sendTokenAlert(
                token,
                {
                  safetyScore: result.safety?.safetyScore || 0,
                  socialScore: result.social?.socialScore || 0,
                  smartMoneyScore: result.smartMoney?.smartMoneyScore || 0,
                  apeProbability: result.apeProbability,
                  isExponential: result.social?.isExponential || false,
                  smartMoneyCount: result.smartMoney?.smartMoneyCount || 0
                },
                result.devProfile,
                result.deepseekAnalysis
              );
            }
          }, 30000);
        } catch (e) {
          // skip profile if pair data unavailable
        }
      }
    }

    // Method 2: Broad Solana search as fallback coverage
    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
    const data = await searchRes.json();

    if (!data.pairs) return;

    const processed = new Set();
    for (const pair of data.pairs) {
      const tokenAddress = pair.baseToken?.address;
      if (!tokenAddress) continue;
      if (processed.has(tokenAddress)) continue;
      processed.add(tokenAddress);

      const existing = await db.getToken(tokenAddress);
      if (existing) continue;

      const mc = pair.fdv || 0;
      if (mc >= 1000000) continue;
      if (mc < 1000) continue;

      console.log(`[MultiDEX] New token from search: ${pair.baseToken?.symbol} (${tokenAddress}) MC: $${mc}`);

      await db.upsertToken({
        address: tokenAddress,
        symbol: pair.baseToken?.symbol,
        name: pair.baseToken?.name,
        current_mc: mc,
        status: 'new',
        created_at: new Date(),
        dex: pair.dexId
      });

      setTimeout(async () => {
        const result = await computeFinalScore(tokenAddress);
        if (result.shouldAlert) {
          const token = await db.getToken(tokenAddress);
          await sendTokenAlert(
            token,
            {
              safetyScore: result.safety?.safetyScore || 0,
              socialScore: result.social?.socialScore || 0,
              smartMoneyScore: result.smartMoney?.smartMoneyScore || 0,
              apeProbability: result.apeProbability,
              isExponential: result.social?.isExponential || false,
              smartMoneyCount: result.smartMoney?.smartMoneyCount || 0
            },
            result.devProfile,
            result.deepseekAnalysis
          );
        }
      }, 30000);
    }
  } catch (err) {
    console.error('[MultiDEX] Scan error:', err.message);
  }
}

// Fetch new tokens from Jupiter (new listings)
async function scanJupiter() {
  try {
    const res = await fetch('https://token.jup.ag/strict');
    const data = await res.json();

    if (!data.tokens) return;

    for (const token of data.tokens) {
      if (!token.address) continue;

      const existing = await db.getToken(token.address);
      if (existing) continue;

      // Only process meme tokens (simple names, high volume potential)
      if (!token.symbol || token.symbol.length > 10) continue;

      console.log(`[Jupiter] New token: ${token.symbol} (${token.address})`);

      await db.upsertToken({
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        status: 'new',
        created_at: new Date()
      });

      // Compute score after a small delay (let initial liquidity settle)
      setTimeout(async () => {
        const result = await computeFinalScore(token.address);
        if (result.shouldAlert) {
          const tokenData = await db.getToken(token.address);
          await sendTokenAlert(tokenData, {/* scores */}, null, result.deepseekAnalysis);
        }
      }, 30000); // Wait 30s before scoring
    }
  } catch (err) {
    console.error('[Jupiter] Scan error:', err.message);
  }
}

async function startMultiDexScanner() {
  console.log('[MultiDEX] Starting multi-DEX scanner (DexScreener + Jupiter)...');

  // Initial scan
  await scanDexScreener();
  await scanJupiter();

  // Periodic scans
  setInterval(async () => {
    await scanDexScreener();
    await scanJupiter();
  }, CHECK_INTERVAL);
}

module.exports = { startMultiDexScanner };
