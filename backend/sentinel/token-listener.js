const WebSocket = require('ws');
const config = require('../config');
const db = require('../database/db');

const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const processingTokens = new Set();
let reconnectTimer = null;
let ws = null;

async function startTokenListener() {
  console.log('[Listener] Starting Helius WebSocket listener...');
  connect();
}

function connect() {
  // Build WebSocket URL from Helius RPC URL
  const rpcUrl = config.helius.rpcUrl || '';
  const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://') ||
    `wss://mainnet.helius-rpc.com/?api-key=${config.helius.apiKey}`;

  console.log('[Listener] Connecting to:', wsUrl.split('?')[0] + '?api-key=***');

  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[Listener] WebSocket connected — subscribing to Pump.fun logs');

    // FIX: correct logsSubscribe format is { mentions: [programId] }
    // Old code used { accounts: [...] } which is wrong and never fires
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMP_FUN_PROGRAM] },
        { commitment: 'processed' }
      ]
    }));
  });

  ws.on('message', async (data) => {
    try {
      const raw = data.toString();
      if (!raw.startsWith('{')) return;

      const parsed = JSON.parse(raw);

      // Subscription confirmed
      if (parsed.id === 1 && parsed.result !== undefined) {
        console.log('[Listener] Subscribed to Pump.fun logs — subscription ID:', parsed.result);
        return;
      }

      if (parsed.method !== 'logsNotification') return;

      const logs = parsed.params?.result?.value?.logs || [];
      const signature = parsed.params?.result?.value?.signature;

      // Only process token creation events
      const isCreate = logs.some(l =>
        l.includes('InitializeMint') ||
        l.includes('MintTo') ||
        l.includes('Create')
      );
      if (!isCreate) return;

      const tokenAddress = extractTokenFromLogs(logs);
      if (!tokenAddress) return;
      if (processingTokens.has(tokenAddress)) return;

      processingTokens.add(tokenAddress);
      console.log(`[Listener] New token detected: ${tokenAddress} (tx: ${signature?.slice(0,8)}...)`);

      // Process async — don't block the WebSocket message loop
      handleNewToken(tokenAddress).finally(() => {
        processingTokens.delete(tokenAddress);
      });

    } catch (err) {
      if (!err.message?.includes('Unexpected token')) {
        console.error('[Listener] Message error:', err.message);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[Listener] WebSocket error:', err.message);
  });

  // FIX: Auto-reconnect — old code had no reconnect, one drop = dead forever
  ws.on('close', (code, reason) => {
    console.log(`[Listener] WebSocket closed (${code}) — reconnecting in 5s...`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  });
}

function extractTokenFromLogs(logs) {
  for (const log of logs) {
    // Pattern 1: "mint: <address>"
    const mintMatch = log.match(/mint:\s*([A-HJ-NP-Za-km-z1-9]{32,44})/);
    if (mintMatch) return mintMatch[1];

    // Pattern 2: "Initialize" followed by address
    const initMatch = log.match(/Initialize[^:]*:\s*([A-HJ-NP-Za-km-z1-9]{32,44})/i);
    if (initMatch) return initMatch[1];

    // Pattern 3: any 44-char base58 string in a Create log
    if (log.includes('Create')) {
      const b58Match = log.match(/[A-HJ-NP-Za-km-z1-9]{44}/);
      if (b58Match && b58Match[0] !== PUMP_FUN_PROGRAM) return b58Match[0];
    }
  }
  return null;
}

async function handleNewToken(tokenAddress) {
  try {
    // Skip if already in DB
    const existing = await db.getToken(tokenAddress);
    if (existing) return;

    // Save immediately so other processes don't double-process
    await db.upsertToken({
      address: tokenAddress,
      status: 'new',
      created_at: new Date()
    });

    // Wait 8 seconds — let the first real transactions land
    // This gives DexScreener time to index it so we can get volume data
    await new Promise(r => setTimeout(r, 8000));

    // Now hand off to the momentum trader for the 3-gate check
    const { handleNewTokenFromListener } = require('../momentum/momentum-trader');
    await handleNewTokenFromListener(tokenAddress);

  } catch (err) {
    console.error('[Listener] Error handling token:', tokenAddress, err.message);
  }
}

module.exports = { startTokenListener };
