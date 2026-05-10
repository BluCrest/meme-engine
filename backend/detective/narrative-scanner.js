const TRENDS_RSS = 'https://trends.google.com/trends/trendingsearches/daily/rss?geo=US';
const REDDIT_SUBS = [
  'https://www.reddit.com/r/CryptoCurrency/hot.json?limit=25',
  'https://www.reddit.com/r/solana/hot.json?limit=25',
  'https://www.reddit.com/r/memecoins/hot.json?limit=25',
  'https://www.reddit.com/r/SolanaMemeCoins/hot.json?limit=25'
];
const NITTER_URLS = [
  'https://nitter.net/search?q=pump.fun&f=tweets',
  'https://nitter.poast.org/search?q=pump.fun&f=tweets',
  'https://nitter.lqdev.org/search?q=pump.fun&f=tweets'
];

let trendingKeywords = [];
let lastFetch = 0;
const REFRESH_INTERVAL = 300000;

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? await r.text() : null;
  } catch { clearTimeout(t); return null; }
}

function extractTrendsFromRSS(xml) {
  const words = [];
  const titleMatches = xml.match(/<title[^>]*>([^<]+)<\/title>/gi) || [];
  for (const m of titleMatches) {
    const title = m.replace(/<\/?title[^>]*>/gi, '').trim().toLowerCase();
    if (title && !title.includes('trends') && !title.includes('google')) {
      words.push(title);
    }
  }
  return words;
}

function extractKeywordsFromText(text, minLen = 3) {
  const words = text.toLowerCase().split(/[\s,.\/#!$%^&*;:{}=\-_`~()'"]+/g);
  const unique = [...new Set(words)];
  return unique.filter(w => w.length >= minLen && !w.match(/^(the|this|that|and|for|are|but|not|you|all|can|had|her|was|one|our|out|has|have|been|some|them|than|what|when|why|will|with|your|its|about|into|over|after|still|also|more|very|just|from|they|been|where|does|would|should|could|how|much|many|such|only|other|than|then|these|those|their|there|which|while|who|whom|which|because|before|after|above|below|under|again|further|moreover|however|therefore|thus|hence|hereby|herein|hereinafter|hereof|hereto|hereunder|hereupon|herewith|thereby|therein|thereinafter|thereof|thereto|thereunder|thereupon|therewith|whereby|wherein|whereof)$/));
}

async function fetchRedditKeywords() {
  const keywords = [];
  for (const url of REDDIT_SUBS) {
    const text = await fetchText(url);
    if (!text) continue;
    try {
      const data = JSON.parse(text);
      const posts = data?.data?.children || [];
      for (const post of posts.slice(0, 10)) {
        const title = post?.data?.title || '';
        const extracted = extractKeywordsFromText(title);
        keywords.push(...extracted);
      }
    } catch {}
  }
  return keywords;
}

async function fetchNitterKeywords() {
  const keywords = [];
  for (const url of NITTER_URLS) {
    const html = await fetchText(url, 6000);
    if (!html) continue;
    const tweets = html.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    for (const t of tweets.slice(0, 20)) {
      const text = t.replace(/<[^>]+>/g, '').trim();
      const extracted = extractKeywordsFromText(text);
      keywords.push(...extracted);
    }
    if (keywords.length > 0) break;
  }
  return keywords;
}

async function refreshKeywords() {
  try {
    const [rss, reddit, nitter] = await Promise.allSettled([
      fetchText(TRENDS_RSS).then(r => r ? extractTrendsFromRSS(r) : []),
      fetchRedditKeywords(),
      fetchNitterKeywords()
    ]);
    const all = [
      ...(rss.status === 'fulfilled' ? rss.value : []),
      ...(reddit.status === 'fulfilled' ? reddit.value : []),
      ...(nitter.status === 'fulfilled' ? nitter.value : [])
    ];
    const freq = {};
    for (const w of all) {
      freq[w] = (freq[w] || 0) + 1;
    }
    trendingKeywords = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .map(([word, count]) => ({ word, score: Math.min(40, count * 10) }));
    lastFetch = Date.now();
  } catch {}
}

function normalizeWord(w) {
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getNarrativeScore(symbol, name) {
  const now = Date.now();
  if (now - lastFetch > REFRESH_INTERVAL) {
    refreshKeywords().catch(() => {});
  }
  if (!trendingKeywords.length) return { score: 0, matched: [], keywords: [] };
  const searchTerms = [
    normalizeWord(symbol || ''),
    normalizeWord(name || ''),
    ...(symbol ? symbol.toLowerCase().split('') : [])
  ];
  const matched = [];
  for (const { word, score } of trendingKeywords) {
    const nw = normalizeWord(word);
    if (searchTerms.some(t => t === nw || (t.length > 3 && nw.includes(t)) || (nw.length > 3 && t.includes(nw)))) {
      matched.push({ word, score });
    }
  }
  const bonus = matched.reduce((sum, m) => sum + m.score, 0);
  return {
    score: Math.min(40, bonus),
    matched: matched.map(m => m.word),
    keywords: trendingKeywords.slice(0, 10).map(k => k.word)
  };
}

module.exports = { getNarrativeScore, refreshKeywords };
