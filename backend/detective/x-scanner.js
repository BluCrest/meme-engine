const axios = require('axios');
const config = require('../config');

const X_API_BASE = 'https://api.twitter.com/2';

async function getXMentions(query, minutesAgo = 60) {
  const startTime = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  try {
    const res = await axios.get(`${X_API_BASE}/tweets/search/recent`, {
      headers: { Authorization: `Bearer ${config.x.bearerToken}` },
      params: {
        query: query,
        max_results: 100,
        start_time: startTime,
        'tweet.fields': 'created_at,public_metrics'
      }
    });
    return res.data.meta.count || 0;
  } catch (err) {
    console.error('[XScanner] Error:', err.response?.data || err.message);
    return 0;
  }
}

async function getKOLMentions(query, minutesAgo = 60) {
  // TODO: Add your KOL list (e.g., '@kol1 OR @kol2') to query
  const startTime = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  try {
    const res = await axios.get(`${X_API_BASE}/tweets/search/recent`, {
      headers: { Authorization: `Bearer ${config.x.bearerToken}` },
      params: {
        query: `${query} (from:kol1 OR from:kol2)`, // Replace with real KOL handles
        max_results: 100,
        start_time: startTime
      }
    });
    return res.data.meta.count || 0;
  } catch (err) {
    console.error('[XScanner] KOL Error:', err.response?.data || err.message);
    return 0;
  }
}

module.exports = { getXMentions, getKOLMentions };