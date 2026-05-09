const config = require('../config');

let MENTION_CACHE = {};

function getAuthHeaders() {
  const token = config.x?.bearerToken;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

async function getXMentions(query, minutesBack = 60) {
  try {
    const cacheKey = `${query}|${minutesBack}`;
    const cached = MENTION_CACHE[cacheKey];
    if (cached && Date.now() - cached.ts < 60000) return cached.count;

    const headers = getAuthHeaders();
    if (!headers) return 0;

    const startTime = new Date(Date.now() - minutesBack * 60000).toISOString();
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=20&tweet.fields=public_metrics,created_at&start_time=${startTime}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      if (res.status === 429) return 0;
      return 0;
    }
    const data = await res.json();

    const count = data.meta?.result_count || 0;
    MENTION_CACHE[cacheKey] = { count, ts: Date.now() };
    return count;
  } catch (_) { return 0; }
}

async function getKOLMentions(query, minutesBack = 60) {
  try {
    const headers = getAuthHeaders();
    if (!headers) return 0;

    const startTime = new Date(Date.now() - minutesBack * 60000).toISOString();
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}+(followers_count:5000 OR followers_count:10000 OR followers_count:50000)&max_results=20&tweet.fields=public_metrics,author_id&start_time=${startTime}&expansions=author_id&user.fields=public_metrics`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return 0;
    const data = await res.json();

    const kolCount = (data.includes?.users || []).filter(u => (u.public_metrics?.followers_count || 0) >= 5000).length;
    return kolCount;
  } catch (_) { return 0; }
}

async function getXSentiment(query, minutesBack = 60) {
  try {
    const headers = getAuthHeaders();
    if (!headers) return { score: 0, volume: 0 };

    const startTime = new Date(Date.now() - minutesBack * 60000).toISOString();
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=50&tweet.fields=public_metrics,created_at,lang&start_time=${startTime}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { score: 0, volume: 0 };
    const data = await res.json();

    const tweets = data.data || [];
    const volume = tweets.length;

    let sentimentScore = 50;
    const bullish = ['moon', 'gem', 'pump', 'buy', 'bullish', 'fomo', 'next', 'giga', 'based', 'wagmi', 'early'];
    const bearish = ['rug', 'scam', 'dump', 'shit', 'dead', 'bust', 'pnd', 'honeypot', 'safu', 'exit'];

    for (const t of tweets) {
      const text = (t.text || '').toLowerCase();
      for (const w of bullish) { if (text.includes(w)) sentimentScore += 2; }
      for (const w of bearish) { if (text.includes(w)) sentimentScore -= 3; }
    }

    sentimentScore = Math.max(0, Math.min(100, sentimentScore));
    return { score: sentimentScore, volume };
  } catch (_) { return { score: 0, volume: 0 }; }
}

module.exports = { getXMentions, getKOLMentions, getXSentiment };
