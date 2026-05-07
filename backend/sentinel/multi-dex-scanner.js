const config = require('../config');
const db = require('../database/db');
const { computeFinalScore } = require('../strategist/score-engine');
const { queueScoredToken } = require('../operator/telegram-bot');

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
        // Skip EVM tokens (0x...) — Solana addresses only
        if (tokenAddress.startsWith('0x') || tokenAddress.length < 32 || tokenAddress.length > 44) continue;

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
            const token = await db.getToken(tokenAddress);
            queueScoredToken(token, result);
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
      if (tokenAddress.startsWith('0x') || tokenAddress.length < 32 || tokenAddress.length > 44) continue;
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
        const token = await db.getToken(tokenAddress);
        queueScoredToken(token, result);
      }, 30000);
    }
  } catch (err) {
    console.error('[MultiDEX] Scan error:', err.message);
  }
}

// Fetch new tokens from Jupiter (new listings)
async function scanJupiter() {
  try {
    // Try multiple endpoints in case one is down
    let tokens;
    for (const url of [
      'https://token.jup.ag/strict',
      'https://tokens.jup.ag/tokens',
      'https://quote-api.jup.ag/v6/tokens'
    ]) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          tokens = await res.json();
          if (tokens) break;
        }
      } catch (_) { /* try next */ }
    }

    if (!tokens) return;
    // Normalize response format: strict returns {tokens:[]}, others return array or map
    const tokenList = Array.isArray(tokens) ? tokens : (tokens.tokens || tokens.mints || []);
    if (!Array.isArray(tokenList) || !tokenList.length) return;

    for (const token of tokenList) {
      const tokenAddress = token.address || token.mint || token.id;
      const tokenSymbol = token.symbol || token.ticker || '';
      const tokenName = token.name || tokenSymbol;
      if (!tokenAddress) continue;

      const existing = await db.getToken(tokenAddress);
      if (existing) continue;

      // Only process meme tokens (simple names, high volume potential)
      if (!tokenSymbol || tokenSymbol.length > 10) continue;

      console.log(`[Jupiter] New token: ${tokenSymbol} (${tokenAddress})`);

      await db.upsertToken({
        address: tokenAddress,
        symbol: tokenSymbol,
        name: tokenName,
        status: 'new',
        created_at: new Date()
      });

      // Compute score after a small delay (let initial liquidity settle)
      setTimeout(async () => {
        const result = await computeFinalScore(tokenAddress);
        const tokenData = await db.getToken(tokenAddress);
        queueScoredToken(tokenData, result);
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
