// Free social scanner using Google News — no API key needed
const MENTION_CACHE = {};

async function getGoogleMentions(query, minutesBack = 60) {
  try {
    const cacheKey = `g|${query}|${minutesBack}`;
    const cached = MENTION_CACHE[cacheKey];
    if (cached && Date.now() - cached.ts < 120000) return cached;

    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://news.google.com/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return { mentions: 0, volume: 0 };
    const html = await res.text();

    const mentionMatches = html.match(/article|href=["']/gi);
    const mentionCount = mentionMatches ? Math.min(mentionMatches.length, 50) : 0;

    const result = { mentions: mentionCount, volume: mentionCount };
    MENTION_CACHE[cacheKey] = { ...result, ts: Date.now() };
    return result;
  } catch (_) { return { mentions: 0, volume: 0 }; }
}

async function getXMentions(query, minutesBack = 60) {
  const data = await getGoogleMentions(query, minutesBack);
  return data.mentions;
}

async function getKOLMentions(query, minutesBack = 60) {
  return 0;
}

async function getXSentiment(query, minutesBack = 60) {
  const data = await getGoogleMentions(query, minutesBack);
  if (!data.mentions) return { score: 50, volume: 0 };

  const encoded = encodeURIComponent(query);
  let bullishCount = 0, bearishCount = 0;
  try {
    const res = await fetch(`https://news.google.com/search?q=${encoded}+(moon+OR+pump+OR+gem+OR+explode)&hl=en-US&gl=US`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.ok) {
      const html = await res.text();
      bullishCount = (html.match(/article/gi) || []).length;
    }
  } catch (_) {}

  try {
    const res = await fetch(`https://news.google.com/search?q=${encoded}+(rug+OR+scam+OR+dump+OR+crash)&hl=en-US&gl=US`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.ok) {
      const html = await res.text();
      bearishCount = (html.match(/article/gi) || []).length;
    }
  } catch (_) {}

  const total = bullishCount + bearishCount;
  const score = total > 0 ? Math.round((bullishCount / total) * 100) : 50;

  return { score, volume: data.volume };
}

module.exports = { getXMentions, getKOLMentions, getXSentiment };
