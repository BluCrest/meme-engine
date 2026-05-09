const INSTANCES = [
  'https://nitter.net',
  'https://nitter.unixfox.eu',
  'https://nitter.lucaburg.xyz',
  'https://nitter.kavin.rocks',
  'https://nitter.1d4.us',
  'https://nitter.poast.org'
];

async function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    return r.ok ? await r.text() : null;
  } catch { clearTimeout(t); return null; }
}

async function searchSymbolOnNitter(symbol, instance) {
  const url = `${instance}/search?f=tops&q=%24${encodeURIComponent(symbol)}&since=&until=&near=`;
  const html = await fetchWithTimeout(url);
  if (!html) return null;
  const postCount = (html.match(/class="tweet-content"/g) || []).length;
  const likeMatches = html.match(/class="icon-heart"[^>]*>.*?<span[^>]*>([\dKMB.]+)<\/span>/gi) || [];
  let totalLikes = 0;
  for (const m of likeMatches) {
    const num = m.match(/([\d.]+)([KMB])?/);
    if (num) {
      const val = parseFloat(num[1]);
      const suffix = num[2] || '';
      totalLikes += suffix === 'K' ? val * 1000 : suffix === 'M' ? val * 1000000 : suffix === 'B' ? val * 1000000000 : val;
    }
  }
  return { postCount, totalLikes, avgLikes: postCount > 0 ? totalLikes / postCount : 0 };
}

async function getSocialScore(symbol, name) {
  const searchTerms = [symbol, name].filter(Boolean);
  if (!searchTerms.length) return { score: 0, posts: 0, likes: 0 };
  for (const instance of INSTANCES) {
    const results = [];
    for (const term of searchTerms.slice(0, 2)) {
      const r = await searchSymbolOnNitter(term, instance);
      if (r) results.push(r);
    }
    if (results.length) {
      const best = results.reduce((a, b) => a.postCount > b.postCount ? a : b);
      const score = Math.min(30, Math.round(best.postCount * 3 + Math.log2(best.totalLikes + 1) * 2));
      return { score, posts: best.postCount, likes: best.totalLikes, instance };
    }
  }
  return { score: 0, posts: 0, likes: 0, instance: null };
}

module.exports = { getSocialScore };
