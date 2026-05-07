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
const CHECK_INTERVAL = 180000; // Check every 3 min

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Two-pass: profiles for discovery, search for batch MC data, individual fetches only when needed
async function scanDexScreener() {
  try {
    // Pass 1: Token profiles — discovers newly created tokens (1 API call)
    const profileRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const profiles = await profileRes.json();

    // Pass 2: Search results — batch MC data for many tokens (1 API call)
    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
    const searchData = await searchRes.json();
    const mcByAddress = new Map();
    const volByAddress = new Map();
    if (searchData.pairs) {
      for (const p of searchData.pairs) {
        if (p.baseToken?.address) {
          mcByAddress.set(p.baseToken.address, p.fdv || 0);
          volByAddress.set(p.baseToken.address, p.volume?.h24 || 0);
        }
      }
    }

    // Merge both sources, deduplicate by address
    const candidates = [];
    const seen = new Set();

    // Collect from search results (already have MC + volume)
    if (searchData.pairs) {
      for (const pair of searchData.pairs) {
        const addr = pair.baseToken?.address;
        if (!addr || addr.startsWith('0x') || addr.length < 32 || addr.length > 44) continue;
        if (seen.has(addr)) continue;
        seen.add(addr);
        const mc = pair.fdv || 0;
        if (mc > 10000 || mc < 1000) continue;
        const vol = pair.volume?.h24 || 0;
        if (vol < 500) continue;
        candidates.push({ addr, symbol: pair.baseToken.symbol, name: pair.baseToken.name, mc, volume: vol, dex: pair.dexId });
      }
    }

    // Collect from profiles (may need individual MC fetch)
    if (Array.isArray(profiles)) {
      for (const profile of profiles) {
        const addr = profile.tokenAddress;
        if (!addr || addr.startsWith('0x') || addr.length < 32 || addr.length > 44) continue;
        if (seen.has(addr)) continue;
        seen.add(addr);

        if (mcByAddress.has(addr)) {
          const mc = mcByAddress.get(addr);
          if (mc > 10000 || mc < 1000) continue;
          const vol = volByAddress.get(addr) || 0;
          if (vol < 500) continue;
          candidates.push({ addr, symbol: profile.symbol, name: profile.name, mc, volume: vol, dex: profile.dexId || 'unknown' });
        } else {
          if (candidates.length > 30) continue;
          await sleep(300);
          try {
            const pairRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
            const pairData = await pairRes.json();
            const pair = pairData.pairs?.[0];
            if (!pair) continue;
            const mc = pair.fdv || 0;
            if (mc > 10000 || mc < 1000) continue;
            const vol = pair.volume?.h24 || 0;
            if (vol < 500) continue;
            candidates.push({ addr, symbol: pair.baseToken?.symbol, name: pair.baseToken?.name, mc, volume: vol, dex: pair.dexId || 'unknown' });
          } catch (_) { /* skip if fetch fails */ }
        }
      }
    }

    // Process all candidates
    for (const c of candidates) {
      const existing = await db.getToken(c.addr);
      if (existing) continue;

      console.log(`[MultiDEX] New token: ${c.symbol || '?'} (${c.addr}) MC: $${c.mc} Vol: $${(c.volume || 0).toLocaleString()}`);

      await db.upsertToken({
        address: c.addr,
        symbol: c.symbol,
        name: c.name,
        current_mc: c.mc,
        volume_24h: c.volume || 0,
        status: 'new',
        created_at: new Date(),
        dex: c.dex
      });

      const delay = 30000 + Math.random() * 60000;
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
      const delay = 30000 + Math.random() * 90000;
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
