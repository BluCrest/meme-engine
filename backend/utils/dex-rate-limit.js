// Shared DexScreener rate limiter — 1 request per 600ms across all modules
let lastCall = 0;

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const gap = now - lastCall;
  if (gap < 600) await new Promise(r => setTimeout(r, 600 - gap));
  lastCall = Date.now();
  const res = await fetch(url, options);
  if (res.status === 429) {
    console.log(`[DexRateLimit] 429 on ${url.slice(0, 60)}... waiting 2s`);
    await new Promise(r => setTimeout(r, 2000));
  }
  return res;
}

module.exports = { rateLimitedFetch };
