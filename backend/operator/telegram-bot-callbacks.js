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
  const parts = data.split('_');
  const action = parts[0];

  if (action === 'sell') {
    const address = parts.slice(1).join('_');
    await sendTelegram('answerCallbackQuery', {
      callback_query_id: query.id
    });
    await sendTelegram('sendMessage', {
      chat_id: query.message.chat.id,
      text: `How much of \`${address.slice(0, 12)}...\` do you want to sell?`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔶 25%', callback_data: `si_${address}_0.25` },
            { text: '🔶 50%', callback_data: `si_${address}_0.5` },
            { text: '🔴 100%', callback_data: `si_${address}_1.0` }
          ]
        ]
      }
    });
    return;
  }

  if (action === 'si') {
    const partsCopy = [...parts];
    const ratioStr = partsCopy.pop();
    const address = partsCopy.slice(1).join('_');
    const ratio = parseFloat(ratioStr);

    try {
      const { executeSell } = require('./trade-executor');
      const result = await executeSell(address, ratio, 'manual');
      await sendTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: result.success ? `💰 Sold ${(ratio * 100).toFixed(0)}%` : '❌ ' + (result.error || 'Sell failed'),
        show_alert: true
      });
      if (result.success) {
        await sendTelegram('editMessageText', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          text: `✅ *Sold* ${(ratio * 100).toFixed(0)}% of \`${address.slice(0, 12)}...\``,
          parse_mode: 'Markdown'
        });
      }
    } catch (e) {
      await sendTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '❌ Error: ' + e.message,
        show_alert: true
      });
    }
    return;
  }

  const address = parts.slice(1).join('_');

  switch (action) {
    case 'ape':
      try {
        const { executeBuy } = require('./trade-executor');
        const result = await executeBuy(address);
        await sendTelegram('answerCallbackQuery', {
          callback_query_id: query.id,
          text: result.success ? '✅ Buy executed!' : '❌ Buy failed: ' + result.error,
          show_alert: true
        });
      } catch (e) {
        await sendTelegram('answerCallbackQuery', {
          callback_query_id: query.id,
          text: '❌ Error: ' + e.message,
          show_alert: true
        });
      }
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
