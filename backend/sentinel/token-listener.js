const { Connection, PublicKey } = require('@solana/web3.js');
const WebSocket = require('ws');
const config = require('../config');
const db = require('../database/db');
const { computeFinalScore } = require('../strategist/score-engine');
const { queueScoredToken } = require('../operator/telegram-bot');

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const processingTokens = new Set();

async function startTokenListener() {
  const connection = new Connection(config.helius.rpcUrl, 'confirmed');

  console.log('[Sentinel] Listening for new Pump.fun tokens...');

  // Use Helius WebSocket for real-time token detection
  try {
    const wsUrl = config.helius.rpcUrl?.replace('https://', 'wss://') || `wss://mainnet.helius-rpc.com/?api-key=${config.helius.apiKey}`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[Sentinel] WebSocket connected');
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: {
          query: { accounts: [PUMP_FUN_PROGRAM] }
        }
      }));
    });

    ws.on('message', async (data) => {
      try {
        const raw = data.toString();
        // Skip non-JSON messages (like "Connection established" etc.)
        if (!raw.startsWith('{') && !raw.startsWith('[')) {
          return;
        }
        const parsed = JSON.parse(raw);

        if (parsed.method === 'logsNotification') {
          const logs = parsed.params?.result?.value?.logs || [];
          const tokenAddress = extractTokenFromLogs(logs);

          if (tokenAddress && !processingTokens.has(tokenAddress)) {
            processingTokens.add(tokenAddress);
            try {
              await processNewToken(tokenAddress);
            } finally {
              processingTokens.delete(tokenAddress);
            }
          }
        }
      } catch (err) {
        // Only log parse errors, not every non-JSON message
        if (!err.message.includes('Unexpected token')) {
          console.error('[Sentinel] WebSocket message error:', err.message);
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[Sentinel] WebSocket error:', err.message);
    });

  } catch (err) {
    console.error('[Sentinel] Failed to start listener:', err.message);
  }
}

function extractTokenFromLogs(logs) {
  for (const log of logs) {
    const match = log.match(/Initialize.*(?:mint|token):\s*([A-Za-z0-9]{32,44})/i);
    if (match) return match[1];
  }
  return null;
}

async function processNewToken(tokenAddress) {
  try {
    console.log(`[Sentinel] New token detected: ${tokenAddress}`);

    const existing = await db.getToken(tokenAddress);
    if (existing) {
      console.log('[Sentinel] Token already tracked, skipping.');
      return;
    }

    // Save token
    await db.upsertToken({
      address: tokenAddress,
      status: 'new',
      created_at: new Date()
    });

    console.log(`[Sentinel] Token ${tokenAddress} saved. Computing score...`);

    // Compute score and alert
    const result = await computeFinalScore(tokenAddress);

    if (result.apeProbability >= 50) {
      const token = await db.getToken(tokenAddress);
      queueScoredToken(token, result);
    }

  } catch (err) {
    console.error('[Sentinel] Error processing new token:', err.message);
  }
}

module.exports = { startTokenListener };