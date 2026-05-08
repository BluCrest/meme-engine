const buckets = new Map();

function getBucket(key, maxTokens = 10, windowMs = 1000) {
  if (!buckets.has(key)) {
    buckets.set(key, { tokens: maxTokens, maxTokens, windowMs, lastRefill: Date.now() });
  }
  return buckets.get(key);
}

function refill(bucket) {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(elapsed / (bucket.windowMs / bucket.maxTokens));
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }
}

async function waitForToken(key, maxTokens = 10, windowMs = 1000) {
  const bucket = getBucket(key, maxTokens, windowMs);
  refill(bucket);
  if (bucket.tokens <= 0) {
    const waitMs = Math.ceil(bucket.windowMs / bucket.maxTokens);
    await new Promise(r => setTimeout(r, waitMs));
    refill(bucket);
  }
  bucket.tokens--;
}

async function rateLimitedFetch(url, options = {}, rateLimitKey = null) {
  const key = rateLimitKey || new URL(url).hostname;
  await waitForToken(key, 10, 1000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 10000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { waitForToken, rateLimitedFetch, getBucket };
