const express = require('express');
const config = require('./config');
const db = require('./database/db');

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'meme-engine running',
    services: {
      exitManager: 'running',
      telegram: 'active',
      render: process.env.RENDER === 'true'
    }
  });
});

// Telegram bot uses direct API calls - no webhook needed
const { sendTokenAlert } = require('./operator/telegram-bot');

// Test endpoint: verify bot is reachable
app.get('/telegram/test', async (req, res) => {
  try {
    const config = require('./config');
    const r = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getMe`);
    const data = await r.json();
    res.json({ ok: true, bot: data });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Telegram webhook endpoint (handles all updates)
app.post('/telegram/callback', async (req, res) => {
  try {
    const { message, callback_query } = req.body;

    if (callback_query) {
      const { handleCallback } = require('./operator/telegram-bot-callbacks');
      await handleCallback(callback_query);
    }

    if (message) {
      const { handleUpdate } = require('./operator/telegram-bot');
      await handleUpdate({ message });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[Server] Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// Manual safety check endpoint
app.get('/check/:tokenAddress', async (req, res) => {
  const { runSafetyCheck } = require('./sentinel/safety-checker');
  try {
    const result = await runSafetyCheck(req.params.tokenAddress);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual alert test endpoint
app.post('/alert/:tokenAddress', async (req, res) => {
  const token = await db.getToken(req.params.tokenAddress);
  if (!token) return res.status(404).json({ error: 'Token not found' });

  const analysis = {
    ape_probability: 50,
    moonshot_probability: 0,
    risk_level: 'medium',
    key_signals: ['Manual test alert'],
    red_flags: [],
    suggested_exit_targets: [2.0],
    reasoning: 'Manual alert via /alert endpoint',
    confidence: 50
  };

  const { sendTokenAlert } = require('./operator/telegram-bot');
  await sendTokenAlert(
    token,
    { safetyScore: 75, socialScore: 60, smartMoneyScore: 40, apeProbability: analysis.ape_probability },
    { label: 'first_time', total_launches: 1, rug_count: 0, avg_return_at_peak: 2.0, reputation_score: 80 },
    analysis
  );
  res.json({ status: 'alert sent', analysis });
});

// Weekly retro endpoint (disabled — no DeepSeek)
app.post('/retro', async (req, res) => {
  res.json({ status: 'disabled', reason: 'DeepSeek API unavailable' });
});

// Score engine endpoint
app.get('/score/:tokenAddress', async (req, res) => {
  const { computeFinalScore } = require('./strategist/score-engine');
  try {
    const result = await computeFinalScore(req.params.tokenAddress);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PnL card endpoint
app.get('/pnl/:tokenAddress', async (req, res) => {
  const { generatePnLCard } = require('./operator/pnl-card');
  const trades = await db.getDb().collection('trades')
    .find({ token_address: req.params.tokenAddress })
    .sort({ timestamp: 1 })
    .toArray();

  if (!trades.length) return res.status(404).json({ error: 'No trades found' });

  try {
    const card = await generatePnLCard(trades[0]);
    res.json({ card });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Portfolio summary
app.get('/portfolio', async (req, res) => {
  const { generatePortfolioSummary } = require('./operator/pnl-card');
  try {
    const summary = await generatePortfolioSummary();
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual buy endpoint
app.post('/buy/:tokenAddress', async (req, res) => {
  const { executeBuy } = require('./operator/trade-executor');
  const { amount } = req.body || {};
  try {
    const result = await executeBuy(req.params.tokenAddress, 'manual', amount);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual sell endpoint
app.post('/sell/:tokenAddress', async (req, res) => {
  const { executeSell } = require('./operator/trade-executor');
  const { ratio, reason } = req.body || {};
  try {
    const result = await executeSell(req.params.tokenAddress, ratio || 1.0, reason || 'manual');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Divergence scan endpoint
app.get('/divergence/:tokenAddress', async (req, res) => {
  const { checkMomentumDivergence } = require('./detective/momentum-divergence');
  try {
    const result = await checkMomentumDivergence(req.params.tokenAddress);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual divergence scan
app.post('/divergence/scan', async (req, res) => {
  const { runDivergenceScan } = require('./detective/momentum-divergence');
  try {
    await runDivergenceScan();
    res.json({ status: 'scan complete' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cross-chain check endpoint
app.get('/cross-chain/:wallet', async (req, res) => {
  const { checkCrossChainHistory } = require('./profiler/cross-chain-tracker');
  try {
    const result = await checkCrossChainHistory(req.params.wallet);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Smart money endpoints
app.get('/smart-money/:tokenAddress', async (req, res) => {
  const { getSmartMoneyScore } = require('./profiler/smart-money');
  try {
    const result = await getSmartMoneyScore(req.params.tokenAddress);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/wallet/:address', async (req, res) => {
  const { getWalletProfile } = require('./profiler/wallet-pnl');
  try {
    const profile = await getWalletProfile(req.params.address);
    res.json(profile || { error: 'Wallet not found' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/top-wallets', async (req, res) => {
  const { getTopPerformingWallets } = require('./profiler/wallet-pnl');
  try {
    const limit = parseInt(req.query.limit) || 10;
    const wallets = await getTopPerformingWallets(limit);
    res.json(wallets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Graduation tracker endpoint
app.get('/graduation/:tokenAddress', async (req, res) => {
  const { getBondingCurveProgress } = require('./strategist/graduation-tracker');
  try {
    const result = await getBondingCurveProgress(req.params.tokenAddress);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Wallet cluster endpoint
app.get('/cluster/:tokenAddress', async (req, res) => {
  const { analyzeWalletClusters } = require('./sentinel/wallet-cluster');
  try {
    const result = await analyzeWalletClusters(req.params.tokenAddress);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Register Telegram connection — webhook on Render, polling locally
async function registerTelegramWebhook() {
  if (process.env.RENDER === 'true') {
    const webhookUrl = process.env.RENDER_EXTERNAL_URL
      ? `https://${process.env.RENDER_EXTERNAL_URL}/telegram/callback`
      : `${process.env.TELEGRAM_WEBHOOK_URL || ''}/telegram/callback`;
    if (webhookUrl) {
      try {
        await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
        console.log(`[Telegram] Webhook set to ${webhookUrl}`);
      } catch (e) {
        console.error('[Telegram] Webhook set failed:', e.message);
      }
    }
  } else {
    try {
      await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/deleteWebhook`);
      console.log('[Telegram] Webhook deleted, using polling');
    } catch (e) {
      console.error('[Telegram] Failed to delete webhook:', e.message);
    }
  }
  const { startPolling } = require('./operator/telegram-bot');
  startPolling();
}

// Start all services
db.connect().then(async () => {
  console.log('[Server] Database connected');

  // Register Telegram webhook
  await registerTelegramWebhook();

  // Start token listener (uses HTTP WebSocket - works everywhere)
  const { startTokenListener } = require('./sentinel/token-listener');
  startTokenListener().catch(err => {
    console.error('[Server] Token listener failed:', err.message);
  });

  // Start multi-DEX scanner (DexScreener + Jupiter + ALL DEXes)
  const { startMultiDexScanner } = require('./sentinel/multi-dex-scanner');
  startMultiDexScanner().catch(err => {
    console.error('[Server] Multi-DEX scanner failed:', err.message);
  });

  // Start exit manager
  const { startExitManager } = require('./operator/exit-manager');
  startExitManager();

  // Start alert batcher (queues scored tokens, sends top 5 >= 80% every 60s)
  const { startAlertBatcher } = require('./operator/telegram-bot');
  startAlertBatcher();

  // Start pre-launch monitor (uses HTTP polling - works everywhere)
  const { startPreLaunchMonitor } = require('./prelaunch/tg-group-monitor');
  startPreLaunchMonitor().catch(err => {
    console.error('[Server] Pre-launch monitor failed:', err.message);
  });

  // Start momentum scanner + trader (primary strategy: volume spikes + buy pressure)
  const { startMomentumScanner } = require('./momentum/momentum-scanner');
  const { startMomentumTrader, handleMomentumTrigger } = require('./momentum/momentum-trader');
  startMomentumScanner(handleMomentumTrigger).catch(err => {
    console.error('[Server] Momentum scanner failed:', err.message);
  });
  startMomentumTrader();

  console.log('[Server] All services started - 24/7 monitoring active');

  app.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
  });
});
