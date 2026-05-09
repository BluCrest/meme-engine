// Shared DexScreener rate limiter — 1 request per 600ms across all modules
let lastCall = 0;

async function rateLimitedFetch(url, options) {
  for (let retry = 0; retry < 3; retry++) {
    const now = Date.now();
    const gap = now - lastCall;
    if (gap < 600) await new Promise(r => setTimeout(r, 600 - gap));
    lastCall = Date.now();
    const res = await fetch(url, options);
    if (res.status === 429) {
      const wait = 2000 * (retry + 1);
      console.log(`[DexRateLimit] 429 on ${url.slice(0, 60)}... retry ${retry + 1}/3, waiting ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      lastCall = 0;
      continue;
    }
    return res;
  }
  return null;
}

module.exports = { rateLimitedFetch };
