// HTTP fetch with retry + exponential backoff for rate limits
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeout || 8000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 429 && attempt < maxRetries) {
        const delay = (options.retryDelay || 1000) * Math.pow(2, attempt);
        console.log(`[Fetch] 429 ${url.slice(0, 60)}... retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (e) {
      if (attempt === maxRetries) throw e;
      const delay = (options.retryDelay || 1000) * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return null;
}

module.exports = { fetchWithRetry };
