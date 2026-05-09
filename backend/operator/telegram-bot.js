const config = require('../config');
const db = require('../database/db');
const { formatX } = require('../utils/format-x');

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Poll getUpdates so commands work without a webhook URL
let pollingOffset = 0;
let pollingInterval;
let pollingBackoff = 0;

async function pollUpdates() {
  if (pollingBackoff > Date.now()) return;
  try {
    const url = `${API_BASE}/getUpdates?offset=${pollingOffset}&timeout=5`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) {
      if (data.error_code === 409) {
        console.log('[TG Poll] 409 conflict — backoff 30s');
        pollingBackoff = Date.now() + 30000;
        return;
      }
      console.log('[TG Poll] API error:', data);
      return;
    }
    pollingBackoff = 0;
    if (data.result?.length) {
      console.log(`[TG Poll] ${data.result.length} update(s), offset=${pollingOffset}`);
      for (const update of data.result) {
        pollingOffset = update.update_id + 1;
        if (update.callback_query) {
          const { handleCallback } = require('./telegram-bot-callbacks');
          await handleCallback(update.callback_query);
        } else if (update.message) {
          await handleUpdate({ message: update.message });
        }
      }
    }
  } catch (e) {
    console.log('[TG Poll] fetch error:', e.message);
  }
}

function startPolling() {
  if (pollingInterval) return;
  if (process.env.RENDER === 'true') {
    console.log('[Telegram] Render env detected — using webhook mode, polling disabled');
    return;
  }
  pollingInterval = setInterval(pollUpdates, 3000);
  setTimeout(pollUpdates, 2000);
  console.log('[Telegram] Polling getUpdates every 3s for commands');
}

const ALERT_THRESHOLD = 50;
const MAX_ALERTS = 20;

// Register command list with Telegram so they show up in the / menu
async function registerCommands() {
  try {
    await sendTelegram('setMyCommands', {
      commands: [
        { command: 'start', description: 'Bot info' },
        { command: 'portfolio', description: 'Wallet balance' },
        { command: 'positions', description: 'Open positions' },
        { command: 'momentum', description: 'Active momentum trades' },
        { command: 'copywallets', description: 'Top tracked wallets' },
        { command: 'pnl', description: 'P&L summary' },
        { command: 'trades', description: 'Recent trades' },
        { command: 'buy', description: 'Buy token: /buy <address> [sol]' },
        { command: 'sell', description: 'Sell position: /sell <address> [ratio]' },
        { command: 'papertrading', description: 'Toggle paper trading on/off' },
        { command: 'report', description: 'Per-token P&L breakdown' },
        { command: 'resume', description: 'Clear circuit breaker, resume buys' },
        { command: 'help', description: 'All commands' },
      ]
    });
    console.log('[Telegram] Commands registered');
  } catch (e) {
    console.error('[Telegram] Failed to register commands:', e.message);
  }
}
registerCommands();

const pendingAlerts = new Map();
const queuedAlerts = [];

function formatMC(mc) {
  if (!mc) return '$0';
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(1)}M`;
  if (mc >= 1e3) return `$${(mc / 1e3).toFixed(1)}K`;
  return `$${mc.toFixed(0)}`;
}

function getProgressBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

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
    console.error('[TelegramBot] Error:', err.message);
    return null;
  }
}

async function sendTokenAlert(token, scores, devProfile, deepseekAnalysis) {
  const riskEmoji = scores.safetyScore > 70 ? '🟢' : scores.safetyScore > 40 ? '🟡' : '🔴';
  const moonEmoji = scores.moonshotProbability > 70 ? '🚀🚀' : scores.moonshotProbability > 50 ? '🚀' : '📈';
  const prelaunchBadge = token.detected_prelaunch
    ? `\n⚡ *PRE-LAUNCH EDGE* — detected ${token.prelaunch_lead_time_seconds}s before live`
    : '';

  const message = `
━━━━━━━━━━━━━━━━━━━━
${moonEmoji} *NEW SIGNAL: $${token.symbol}*
━━━━━━━━━━━━━━━━━━━━
${prelaunchBadge}
*MC:* ${formatMC(token.current_mc)}
*Pump.fun Progress:* ${token.bonding_curve_progress || 0}% ${getProgressBar(token.bonding_curve_progress || 0)}

📊 *SCORES*
${riskEmoji} Safety: ${scores.safetyScore}/100
📣 Social: ${scores.socialScore}/100 ${scores.isExponential ? '⚡ VIRAL SURGE' : ''}
🧠 Smart Money: ${scores.smartMoneyScore}/100 (${scores.smartMoneyCount || 0} wallets)

🎯 *PROBABILITIES*
Ape In: *${scores.apeProbability}%*
Moonshot: *${scores.moonshotProbability}%*
Absolute Nuke: *${scores.absoluteMoonshotProbability || 0}%*

👨‍💻 *DEV PROFILE*
Type: ${devProfile?.label || 'unknown'}
Launches: ${devProfile?.total_launches || 0} | Rugs: ${devProfile?.rug_count || 0}
Avg Peak Return: *${(devProfile?.avg_return_at_peak || 0).toFixed(1)}x*
Rep Score: ${devProfile?.reputation_score || 0}/100

📝 *DEEPSEEK ANALYSIS*
${deepseekAnalysis?.reasoning || 'N/A'}

*CA:* \`${token.address}\`
━━━━━━━━━━━━━━━━━━━━
`;

  const buttons = {
    inline_keyboard: [
      [
        { text: '✅ Ape In', callback_data: `ape_${token.address}` },
        { text: '❌ Skip', callback_data: `skip_${token.address}` }
      ],
      [
        { text: '📊 Full Report', callback_data: `report_${token.address}` },
        { text: '👨‍💻 Dev History', callback_data: `dev_${token.address}` }
      ]
    ]
  };

  const result = await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    reply_markup: buttons
  });

  if (result?.result?.message_id) {
    pendingAlerts.set(token.address, result.result.message_id);
  }

  return result;
}

function queueScoredToken(token, result) {
  queuedAlerts.push({ token, result, time: Date.now() });
}

async function flushTopAlerts() {
  if (!queuedAlerts.length) return;

  const now = Date.now();
  const fresh = queuedAlerts.filter(a => now - a.time < 300000);
  queuedAlerts.length = 0;
  console.log(`[AlertBatcher] ${fresh.length} queued, filtering for >= ${ALERT_THRESHOLD}%...`);

  const scores = fresh.map(a => `${a.token.symbol || '?'}:${a.result.apeProbability ?? 0}%`).join(', ');
  const eligible = fresh
    .filter(a => (a.result.apeProbability ?? 0) >= ALERT_THRESHOLD)
    .sort((a, b) => (b.result.apeProbability ?? 0) - (a.result.apeProbability ?? 0))
    .slice(0, MAX_ALERTS);

  console.log(`[AlertBatcher] Scores: [${scores}] → ${eligible.length} eligible`);
  if (!eligible.length) return;

  let message = `🚀 *TOP ${eligible.length} SIGNALS*\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (let i = 0; i < eligible.length; i++) {
    const { token, result } = eligible[i];
    const riskEmoji = result.safety?.safetyScore > 70 ? '🟢' : result.safety?.safetyScore > 40 ? '🟡' : '🔴';
    const symbol = token.symbol || 'UNKNOWN';
    const mc = token.current_mc || 0;
    const devLabel = result.devProfile?.label || 'unknown';
    const convictionLabel = result.conviction?.label || '';

    message += `*#${i + 1}* ${riskEmoji} *$${symbol}* — ${result.apeProbability}% ${convictionLabel}\n`;
    message += `   MC: ${formatMC(mc)} | Vol: $${formatMC(token.volume_24h || 0)} | Safety: ${result.safety?.safetyScore || '?'}\n`;
    message += `   Dev: ${devLabel} | CA: \`${token.address}\`\n\n`;
  }

  message += `━━━━━━━━━━━━━━━━━━━━\nUse /positions and /portfolio to manage`;

  const sent = await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  });

  if (sent?.ok) {
    console.log(`[AlertBatcher] Alert sent (${eligible.length} tokens)`);
  } else {
    console.error(`[AlertBatcher] Send failed:`, sent?.description || 'unknown');
  }

  // Auto-buy top 2 tokens from this batch
  await autoBuyTopN(eligible, 2);
}

async function autoBuyTopN(eligible, n) {
  const { executeBuy, getBalance } = require('./trade-executor');
  const db = require('../database/db');
  const { isTokenInCooldown, checkCircuitBreakers } = require('./exit-manager');
  const { checkVitality } = require('../utils/token-vitality');

  // Circuit breaker: check if trading should pause
  const cb = await checkCircuitBreakers();
  if (cb.stopTrading) {
    console.log(`[AutoBuy] Circuit breaker: ${cb.reason}`);
    return;
  }

  // Safety gates (both static + vitality re-check)
  const safe = [];
  for (const e of eligible) {
    const r = e.result;
    const t = e.token;
    if (r.bundleInfo?.bundleDetected) continue;
    if (r.clusterAnalysis?.clusterRisk === 'high') continue;
    if (r.safety?.safetyScore < 40) continue;
    if (r.divergenceCheck?.divergenceScore > 50) continue;
    if (r.safety?.top5Concentration > 50) continue;
    if (r.devProfile?.label === 'serial_rugger') continue;
    if (r.devProfile?.rug_count >= 3) continue;
    // Pump.fun bonding curve tokens never have LP locked until graduation — skip that check
    // Re-check token vitality at buy time (might have died since scoring)
    const nowVitality = await checkVitality(t.address, null);
    if (nowVitality.isDead) {
      console.log(`[AutoBuy] ${t.symbol} is dead (${nowVitality.reasons.join(', ')}), skipping`);
      continue;
    }
    safe.push(e);
  }

  if (!safe.length) {
    console.log(`[AutoBuy] No tokens passed safety gates`);
    return;
  }

  // Check current open positions count and total invested
  const openPositions = await db.getOpenPositions();
  const openAddresses = new Set(openPositions.map(p => p.token_address));
  const MAX_POSITIONS = 5;
  const MAX_PORTFOLIO_PCT = 0.5;
  if (openPositions.length >= MAX_POSITIONS) {
    console.log(`[AutoBuy] ${openPositions.length} positions open, skipping buy (max ${MAX_POSITIONS})`);
    return;
  }
  const totalInvested = openPositions.reduce((s, p) => s + (p.sol_invested || 0), 0);
  const bal = await getBalance();
  const availableBudget = bal * MAX_PORTFOLIO_PCT - totalInvested;
  if (availableBudget <= 0.001) {
    console.log(`[AutoBuy] Budget used (${totalInvested.toFixed(3)}/${(bal * MAX_PORTFOLIO_PCT).toFixed(3)} SOL), skipping`);
    return;
  }

  const top = safe.slice(0, n);

  for (const { token, result } of top) {
    try {
      // Skip if token is in cooldown (recently stopped out)
      if (await isTokenInCooldown(token.address)) {
        console.log(`[AutoBuy] ${token.symbol} in cooldown, skipping`);
        continue;
      }

      // Skip if already holding this token open
      if (openAddresses.has(token.address)) {
        console.log(`[AutoBuy] ${token.symbol} already held open, skipping`);
        continue;
      }

      // Fresh token sizing (<2min = quick flip, smaller, tighter)
      const isFresh = (token.age_min || 999) < 2;
      const score = result.apeProbability;
      const convictionRank = result.conviction?.rank || 1;
      const convictionMultiplier = convictionRank === 4 ? 1.5 : convictionRank === 3 ? 1.0 : 0.5;
      const sizeMultiplier = isFresh ? 0.3 : score >= 90 ? 1.5 * convictionMultiplier : score >= 80 ? 1.0 * convictionMultiplier : 0.5 * convictionMultiplier;
      const maxPerTrade = config.config.maxSolPerTrade || 0.1;
      const amount = Math.min(maxPerTrade * sizeMultiplier, availableBudget / top.length);
      if (amount < 0.001) {
        console.log(`[AutoBuy] ${token.symbol} amount ${amount.toFixed(4)} < 0.001, skipping`);
        continue;
      }

      const buyResult = await executeBuy(token.address, 'auto_signal', amount);
      if (buyResult.success) {
        // Sell target from local synthesis
        const targets = result.deepseekAnalysis?.suggested_exit_targets;
        let sellTarget;
        if (Array.isArray(targets) && targets.length) {
          sellTarget = targets.reduce((a, b) => a + b, 0) / targets.length;
        } else {
          // Fallback: map score to target
          sellTarget = 1 + score / 60; // 67% → 2.1x, 80% → 2.3x, 95% → 2.6x
        }
        const exitMultiplier = Math.max(sellTarget * 0.985, isFresh ? 1.2 : 1.6);

        const moonshotPct = result.moonshotProbability || result.deepseekAnalysis?.moonshot_probability || 0;
        await db.getDb().collection('positions').updateOne(
          { token_address: token.address, status: 'open' },
          { $set: { sell_target_multiplier: exitMultiplier, sell_target_set_at: new Date(), auto_buy_score: score, moonshot_probability: moonshotPct } }
        );

        const convLabel = result.conviction?.label || '';
        const notifyMsg = `🤖 *AUTO-BOUGHT* $${token.symbol || ''}\n${amount.toFixed(4)} SOL | ${convLabel} | Target: ${exitMultiplier.toFixed(2)}x${isFresh ? ' ⚡FLIP' : ''} | Score: ${score}%`;
        await sendTelegram('sendMessage', { chat_id: CHAT_ID, text: notifyMsg, parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error(`[AutoBuy] Failed ${token.address}:`, e.message);
    }
  }
}

function startAlertBatcher() {
  setInterval(flushTopAlerts, 60000);
  console.log('[Telegram] Alert batcher started (every 1 min, top 20 >= 50%)');
}

// Handle /start command and other messages
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const text = msg.text;

  if (text === '/start') {
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '🚀 *Meme Engine Active!*\n\n⚡ Momentum sniping active — scans for volume spikes every 60s, auto-buys on buy pressure. Legacy scoring still running for quality plays.\n\nCommands:\n/portfolio - Wallet balance\n/positions - View open positions\n/momentum - Active momentum trades\n/pnl - P&L summary\n/trades - Recent trades\n/buy <addr> - Buy a token\n/sell <addr> - Sell a position\n/help - All commands',
      parse_mode: 'Markdown'
    });
  }

  if (text === '/portfolio') {
    const { getBalance } = require('./trade-executor');
    const bal = await getBalance();
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `💰 *Wallet Balance*\n\n${bal.toFixed(4)} SOL`,
      parse_mode: 'Markdown'
    });
  }

  if (text === '/positions') {
    const db = require('../database/db');
    const positions = await db.getDb().collection('positions').find({ status: 'open' }).toArray();
    if (!positions.length) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: 'No open positions.' });
      return;
    }
    let msg = '📊 *Open Positions*\n\n';
    const rows = [];
    for (const p of positions) {
      const addr = p.token_address;
      if (!addr) continue;
      const currentPrice = await require('../utils/price-feed').getCurrentPrice(addr);
      const pnl = p.entry_price > 0 ? ((currentPrice / p.entry_price) - 1) * 100 : 0;
      const ticker = p.symbol || addr.slice(0, 8);
      const { formatX } = require('../utils/format-x');
      const xRet = formatX(pnl / 100);
      msg += `$${ticker} — ${pnl.toFixed(1)}% (${xRet})\n   \`${addr}\`\n`;
      rows.push([{ text: `🔴 Sell $${ticker}`, callback_data: `sell_${addr}` }]);
    }
    msg += `\nUse /sell \\\`address\\\` [ratio] to sell directly`;
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: msg,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows }
    });
  }

  if (text === '/pnl') {
    const { getBalance } = require('./trade-executor');
    const { checkCircuitBreakers } = require('./exit-manager');
    const openPositions = await db.getDb().collection('positions').find({ status: 'open' }).toArray();
    const allTrades = await db.getDb().collection('trades').find().sort({ timestamp: -1 }).toArray();
    const stopLosses = await db.getDb().collection('stop_losses').find().sort({ stopped_at: -1 }).limit(10).toArray();
    const bal = await getBalance();

    // Match buys and sells by token_address to compute real PnL
    const buys = allTrades.filter(t => t.action === 'buy');
    const sells = allTrades.filter(t => t.action === 'sell');
    const buyMap = new Map();
    for (const b of buys) {
      if (!buyMap.has(b.token_address)) buyMap.set(b.token_address, []);
      buyMap.get(b.token_address).push(b);
    }

    let totalInvested = 0, totalReturned = 0, wins = 0, losses = 0, maxProfitTrade = null, maxProfitPct = 0;
    for (const s of sells) {
      const addr = s.token_address;
      const matchedBuys = buyMap.get(addr) || [];
      // Find the buy that invested into this sell (by matching sol amount range)
      const buy = matchedBuys.find(b => b.sol_amount && s.sol_amount && Math.abs(b.sol_amount - s.sol_amount) < s.sol_amount * 0.5) || matchedBuys.pop();
      const investAmount = buy?.sol_amount || 0;
      const returnAmount = s.sol_amount || 0;
      totalInvested += investAmount;
      totalReturned += returnAmount;
      const profit = returnAmount - investAmount;
      const pnlPct = investAmount > 0 ? ((returnAmount / investAmount) - 1) * 100 : 0;
      if (profit >= 0) wins++; else losses++;
      if (pnlPct > maxProfitPct) {
        maxProfitPct = pnlPct;
        maxProfitTrade = { symbol: s.symbol || addr.slice(0, 8), pnlPct, profit };
      }
    }

    const netPnl = totalReturned - totalInvested;
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const slCount = stopLosses.length;
    const todaySl = stopLosses.filter(s => new Date(s.stopped_at) > new Date(Date.now() - 86400000)).length;

    const cb = await checkCircuitBreakers();

    let msg = `📈 *P&L Summary*
━━━━━━━━━━━━━━━━━━━━
💰 *Wallet:* ${bal.toFixed(4)} SOL
📊 *Trades:* ${sells.length} closed | ${openPositions.length} open
🎯 *Win Rate:* ${winRate.toFixed(0)}% (${wins}W / ${losses}L)
📉 *Stop-Losses:* ${slCount} total (${todaySl} today)
💵 *Net P&L:* ${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} SOL
${maxProfitTrade ? `🏆 *Best Trade:* $${maxProfitTrade.symbol} — +${maxProfitTrade.pnlPct.toFixed(0)}% (${formatX(maxProfitTrade.pnlPct/100)})` : ''}
${cb.stopTrading ? '\n🟡 *NEW BUYS PAUSED* — ' + cb.reason + '\n_Existing positions still managed (stop-losses, exits active)_\nUse /resume to clear' : ''}

━━━━━━━━━━━━━━━━━━━━
Use /portfolio for balance, /positions for open trades`;
    await sendTelegram('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
  }

  if (text === '/trades') {
    const trades = await db.getDb().collection('trades').find().sort({ timestamp: -1 }).limit(10).toArray();
    if (!trades.length) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: 'No trades yet.' });
      return;
    }
    let msg = '📋 *Recent Trades*\n━━━━━━━━━━━━━━━━━━━━\n\n';
    for (const t of trades) {
      const emoji = t.action === 'buy' ? '✅' : '💰';
      const time = new Date(t.timestamp).toLocaleString();
      msg += `${emoji} *${t.action.toUpperCase()}* ${t.token_address.slice(0, 8)}...\n`;
      msg += `   ${t.sol_amount?.toFixed(4)} SOL | ${time}\n\n`;
    }
    await sendTelegram('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
  }

  if (text === '/report') {
    const allTrades = await db.getDb().collection('trades').find().sort({ timestamp: -1 }).toArray();
    const buys = allTrades.filter(t => t.action === 'buy');
    const sells = allTrades.filter(t => t.action === 'sell');
    const tokens = new Map();
    for (const b of buys) {
      if (!tokens.has(b.token_address)) tokens.set(b.token_address, { buys: [], sells: [] });
      tokens.get(b.token_address).buys.push(b);
    }
    for (const s of sells) {
      if (!tokens.has(s.token_address)) tokens.set(s.token_address, { buys: [], sells: [] });
      tokens.get(s.token_address).sells.push(s);
    }
    const perToken = [];
    for (const [addr, data] of tokens) {
      if (!data.sells.length) continue;
      const totalInvested = data.buys.reduce((s, b) => s + (b.sol_amount || 0), 0);
      const totalReturned = data.sells.reduce((s, sel) => s + (sel.sol_amount || 0), 0);
      const pnl = totalReturned - totalInvested;
      const pnlPct = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;
      const symbol = data.sells[0]?.symbol || data.buys[0]?.symbol || addr.slice(0, 8);
      perToken.push({ addr, symbol, totalInvested, totalReturned, pnl, pnlPct });
    }
    perToken.sort((a, b) => b.pnlPct - a.pnlPct);
    let msg = '📋 *Per-Token P&L*\n━━━━━━━━━━━━━━━━━━━━\n\n';
    let winners = 0, losers = 0;
    for (const t of perToken) {
      const emoji = t.pnl >= 0 ? '🟢' : '🔴';
      if (t.pnl >= 0) winners++; else losers++;
      msg += `${emoji} $${t.symbol} — ${t.pnl >= 0 ? '+' : ''}${t.pnlPct.toFixed(0)}% (${formatX(t.pnlPct / 100)})\n`;
      msg += `   Invested ${t.totalInvested.toFixed(4)} → Returned ${t.totalReturned.toFixed(4)} SOL\n\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n${winners} winners / ${losers} losers`;
    await sendTelegram('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
  }

  if (text === '/momentum') {
    try {
      const { activePositions } = require('../momentum/momentum-trader');
      const { getBalance } = require('./trade-executor');
      const bal = await getBalance();
      if (!activePositions.size) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: `⏳ No active momentum trades. Balance: ${bal.toFixed(4)} SOL\n\nMomentum scanner watches for volume spikes every 60s. Buys on: vol spike + buy pressure + high activity.` });
        return;
      }
      let msg = `⚡ *Momentum Positions* (${activePositions.size}/3)\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const [addr, pos] of activePositions) {
        const currentPrice = await require('../utils/price-feed').getCurrentPrice(addr);
        const pnl = pos.entryPrice > 0 && currentPrice > 0 ? ((currentPrice / pos.entryPrice) - 1) * 100 : 0;
        const emoji = pnl > 10 ? '🚀' : pnl > 0 ? '📈' : '📉';
        const xRet = formatX(pnl / 100);
        msg += `${emoji} *$${pos.symbol}* — ${pnl.toFixed(1)}% (${xRet})\n`;
        msg += `   Entry: $${pos.entryPrice.toFixed(8)} | Now: $${currentPrice?.toFixed(8) || '?'}\n`;
        msg += `   Invested: ${pos.solInvested.toFixed(4)} SOL\n\n`;
      }
      msg += `Balance: ${bal.toFixed(4)} SOL`;
      await sendTelegram('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[Telegram] /momentum error:', e.message);
    }
  }

  if (text === '/copywallets') {
    try {
      const copyTrader = require('../agents/copy-trader');
      const wallets = copyTrader.getTopWallets(10);
      if (!wallets.length) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: '📭 No tracked wallets yet. Copy trader is learning — needs more token observations before it identifies profitable deployers.' });
        return;
      }
      let msg = `👥 *Top Tracked Wallets*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      for (const w of wallets) {
        const emoji = w.score > 50 ? '🟢' : w.score > 0 ? '🟡' : '🔴';
        msg += `${emoji} \`${w.wallet.slice(0, 8)}...\` Score: ${w.score} | Avg: ${(w.avgReturn * 100).toFixed(0)}% | Tokens: ${w.totalTokens}\n`;
      }
      msg += `\n_New wallets discovered automatically as tokens are scanned._`;
      await sendTelegram('sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[Telegram] /copywallets error:', e.message);
    }
  }

  if (text === '/help') {
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `🚀 *Meme Engine Commands*
/start - Bot info
/portfolio - Wallet balance
/positions - View open positions
/momentum - Active momentum trades
/copywallets - Top tracked profitable wallets
/pnl - P&L summary
/trades - Recent trade history
/buy <address> [sol] - Buy a token
/sell <address> [ratio] - Sell a position (1.0=100%)
/papertrading [on|off] - Toggle paper trading mode (no real tx)
/report - Per-token P&L breakdown
/resume - Clear circuit breaker, resume new buys
/help - This message

⚡ Momentum: scans every 60s, buys volume spikes + buy pressure, 1.5x target, trailing stop, -30% hard stop.
👥 Copy Trader: tracks profitable wallets from GMGN ranking + deployer performance. Auto-buys when known-good wallets launch.
📊 Legacy: scores ≥65% alert, top 2 auto-bought, pattern memory + adaptive weights.
Circuit breaker: pauses new buys after 3 consecutive losses or daily loss limit. Use /resume to clear.`,
      parse_mode: 'Markdown'
    });
  }

  if (text === '/papertrading' || text?.startsWith('/papertrading ')) {
    const parts = text.split(' ');
    const action = parts[1];
    const { getPaperTrading, setPaperTrading } = require('../database/db');
    if (action === 'on') {
      await setPaperTrading(true);
      await sendTelegram('sendMessage', { chat_id: chatId, text: '📝 Paper trading: *ON* — no real transactions will be executed', parse_mode: 'Markdown' });
    } else if (action === 'off') {
      await setPaperTrading(false);
      await sendTelegram('sendMessage', { chat_id: chatId, text: '🔥 Paper trading: *OFF* — real transactions will be executed', parse_mode: 'Markdown' });
    } else {
      const current = await getPaperTrading();
      await sendTelegram('sendMessage', { chat_id: chatId, text: `📝 Paper trading is currently *${current ? 'ON' : 'OFF'}*\n\nUse /papertrading on or /papertrading off to toggle.`, parse_mode: 'Markdown' });
    }
  }

  if (text === '/buy' || text?.startsWith('/buy ')) {
    const parts = text.split(' ');
    const addr = parts[1];
    const amount = parseFloat(parts[2]) || undefined;
    if (!addr || addr.length < 32) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: 'Usage: /buy <token_address> [sol_amount]\nExample: /buy 7GCihgDB8fe6KNjn2MYtkzZcRj12u6T6GcECpK8ZBo5F 0.05' });
      return;
    }
    try {
      const { executeBuy } = require('./trade-executor');
      const { checkCircuitBreakers } = require('./exit-manager');
      const cb = await checkCircuitBreakers();
      if (cb.stopTrading) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: `🟡 *Circuit breaker active* — ${cb.reason}\nUse /resume to clear` });
        return;
      }
      const result = await executeBuy(addr, 'manual', amount);
      if (result.success) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: `✅ *Buy executed*\n${result.trade?.sol_amount?.toFixed(4) || '?'} SOL | CA: \`${addr}\``, parse_mode: 'Markdown' });
      } else {
        await sendTelegram('sendMessage', { chat_id: chatId, text: `❌ *Buy failed*\n${result.error}`, parse_mode: 'Markdown' });
      }
    } catch (e) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
    }
  }

  if (text === '/sell' || text?.startsWith('/sell ')) {
    const parts = text.split(' ');
    const addr = parts[1];
    const ratio = parseFloat(parts[2]) || 1.0;
    if (!addr || addr.length < 32) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: 'Usage: /sell <token_address> [ratio]\nRatio: 1.0 = 100%, 0.5 = 50%\nExample: /sell 7GCihgDB8fe6KNjn2MYtkzZcRj12u6T6GcECpK8ZBo5F 0.5' });
      return;
    }
    try {
      const { executeSell } = require('./trade-executor');
      const result = await executeSell(addr, ratio, 'manual');
      if (result.success) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: `💰 *Sell executed*\n${(ratio * 100).toFixed(0)}% of position | CA: \`${addr}\``, parse_mode: 'Markdown' });
      } else {
        await sendTelegram('sendMessage', { chat_id: chatId, text: `❌ *Sell failed*\n${result.error}`, parse_mode: 'Markdown' });
      }
    } catch (e) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: '❌ Error: ' + e.message });
    }
  }

  if (text === '/resume') {
    const db = require('../database/db');
    const { checkCircuitBreakers } = require('./exit-manager');
    await db.getDb().collection('stop_losses').deleteMany({});
    console.log('[Telegram] Circuit breaker reset via /resume');
    await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ *Circuit breaker cleared* — new buys resumed\n\nStop-loss history wiped. Bot will start buying again on next scan cycle.', parse_mode: 'Markdown' });
  }
}

async function sendTradeNotification(token, type, amount, pnl = null) {
  const emoji = type === 'buy' ? '✅' : '💰';
  const title = type === 'buy' ? 'Bought' : 'Sold';
  let msg = `${emoji} *${title}: $${token.symbol || 'UNKNOWN'}*\n\n`;
  msg += `Amount: ${amount.toFixed(4)} SOL\n`;
  msg += `Price: $${token.price?.toFixed(6)}\n`;
  if (pnl !== null) {
    msg += `P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}% (${pnl > 0 ? '🚀' : '📉'})\n`;
  }
  msg += `\n*CA:* \`${token.address}\``;

  await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: msg,
    parse_mode: 'Markdown'
  });
}

// Urgent bypass: send high-confidence alerts immediately, skip batcher
async function sendUrgentAlert(token, result) {
  const riskEmoji = result.safety?.safetyScore > 70 ? '🟢' : result.safety?.safetyScore > 40 ? '🟡' : '🔴';
  const symbol = token.symbol || 'UNKNOWN';
  const mc = token.current_mc || 0;

  const message = `⚡ *URGENT: $${symbol}* ${riskEmoji}
━━━━━━━━━━━━━━━━━━━━
Score: *${result.apeProbability}%* | MC: ${formatMC(mc)}
Safety: ${result.safety?.safetyScore || '?'} | Conviction: ${result.conviction?.label || ''}
${result.vitality?.momentum === 'active' ? '🔥 Momentum: ACTIVE\n' : ''}
${result.graduationInfo?.graduationSignal === 'graduating_now' ? '🎓 Graduating NOW\n' : ''}

*CA:* \`${token.address}\``;

  const buttons = {
    inline_keyboard: [
      [
        { text: '✅ Ape In', callback_data: `ape_${token.address}` },
        { text: '❌ Skip', callback_data: `skip_${token.address}` }
      ]
    ]
  };

  await sendTelegram('sendMessage', {
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    reply_markup: buttons
  });
}

module.exports = { sendTokenAlert, queueScoredToken, flushTopAlerts, startAlertBatcher, startPolling, handleUpdate, sendTradeNotification, sendUrgentAlert };
