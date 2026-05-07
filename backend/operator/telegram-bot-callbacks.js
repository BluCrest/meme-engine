const config = require('../config');
const db = require('../database/db');

const BOT_TOKEN = config.telegram.botToken;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendTelegram(method, data = {}) {
  try {
    const url = `${API_BASE}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    console.error('[Callback] Error:', err.message);
    return null;
  }
}

async function handleCallback(query) {
  const data = query.data;
  const [action, address] = data.split('_');

  switch (action) {
    case 'ape':
      await sendTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '🚀 Ape in! Check /buy endpoint',
        show_alert: true
      });
      break;
    case 'skip':
      await db.upsertToken({ address, status: 'passed' });
      await sendTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '❌ Skipped'
      });
      break;
    case 'report':
      await sendTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '📊 Full report coming soon!'
      });
      break;
    case 'dev':
      await sendTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '👨‍💻 Dev history coming soon!'
      });
      break;
  }
}

module.exports = { handleCallback };
