const config = require('../config');
const db = require('../database/db');
const { computeFinalScore } = require('../strategist/score-engine');
const { queueScoredToken } = require('../operator/telegram-bot');
const { fetchAllNewTokens } = require('../sources/source-rotator');

// DEX Program IDs to monitor
const DEX_PROGRAMS = {
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNyFb3mnxVb6pZ6EBGiZZj4',
  RAYDIUM: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  ORCA: '9W959DqY188ahmGk8L543LrjxK5JR8qZz6mFHjV5Gks',
  METEORA: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6XyZnWr1L2nZ',
  PHOTON: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
};

let lastChecked = Date.now();
const CHECK_INTERVAL = 180000; // Check every 3 min

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Multi-source: token discovery from DexScreener + GMGN + Pump.fun
async function scanDexScreener() {
  try {
    const profiles = await fetchAllNewTokens();
    const candidates = [];

    for (const profile of (profiles || [])) {
      const addr = profile.tokenAddress;
      if (!addr || addr.startsWith('0x') || addr.length < 32 || addr.length > 44) continue;

      const existing = await db.getToken(addr);
      if (existing) continue;

      candidates.push({ addr, symbol: profile.symbol, name: profile.name, dex: profile.dexId || 'unknown' });
    }

    // Process all candidates
    for (const c of candidates) {
      const existing = await db.getToken(c.addr);
      if (existing) continue;

      console.log(`[MultiDEX] New token: ${c.symbol || '?'} (${c.addr})`);

      await db.upsertToken({
        address: c.addr,
        symbol: c.symbol,
        name: c.name,
        status: 'new',
        created_at: new Date(),
        dex: c.dex
      });

      const delay = 15000;
      setTimeout(async () => {
        try {
          const result = await computeFinalScore(c.addr);
          const token = await db.getToken(c.addr);
          if (token) queueScoredToken(token, result);
        } catch (e) {
          console.error(`[MultiDEX] Score failed for ${c.symbol || c.addr}:`, e.message);
        }
      }, delay);
    }

    if (candidates.length) console.log(`[MultiDEX] Found ${candidates.length} new tokens this cycle`);
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
        volume_24h: 0,
        status: 'new',
        created_at: new Date()
      });

      // Stagger scoring to avoid RPC spikes
      const delay = 15000;
      setTimeout(async () => {
        try {
          const result = await computeFinalScore(tokenAddress);
          const tokenData = await db.getToken(tokenAddress);
          if (tokenData) queueScoredToken(tokenData, result);
        } catch (e) {
          console.error(`[Jupiter] Score failed for ${tokenSymbol}:`, e.message);
        }
      }, delay);
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
