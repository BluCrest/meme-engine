const { Connection } = require('@solana/web3.js');
const config = require('../config');

const PUBLIC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
  'https://solana.publicnode.com',
  'https://free.rpcpool.com',
  'https://api.metaplex.solana.com'
];

const connections = [];
let currentIndex = 0;

// ---- Rate limiter: 5 req/s global ----
const MIN_RPC_GAP = 200;
let lastRpcTime = 0;

async function waitForRpcSlot() {
  const now = Date.now();
  const elapsed = now - lastRpcTime;
  if (elapsed < MIN_RPC_GAP) {
    await new Promise(r => setTimeout(r, MIN_RPC_GAP - elapsed));
  }
  lastRpcTime = Date.now();
}

// ---- Per-endpoint cooldown after 429/403 ----
const cooldowns = [];
const BACKOFF = [2000, 5000, 10000, 20000];

function blockEndpoint(idx) {
  const attempt = (cooldowns[idx]?.attempt || 0) + 1;
  const step = Math.min(attempt - 1, BACKOFF.length - 1);
  const dur = BACKOFF[step];
  cooldowns[idx] = { until: Date.now() + dur, attempt };
  console.log(`[RPC] Blocked ep ${idx + 1}/${connections.length} for ${dur}ms`);
}

function findFreeEndpoint() {
  for (let i = 0; i < connections.length; i++) {
    const idx = (currentIndex + 1 + i) % connections.length;
    const c = cooldowns[idx];
    if (!c || Date.now() >= c.until) {
      currentIndex = idx;
      return connections[idx];
    }
  }
  return null;
}

// ---- In-flight dedup + short cache ----
const rpcCache = new Map();
const CACHE_TTL = 3000;

async function cachedRpc(cacheKey, fn) {
  const existing = rpcCache.get(cacheKey);
  if (existing?.promise) return existing.promise;
  if (existing && Date.now() - existing.ts < CACHE_TTL) return existing.result;
  const promise = fn().then(r => {
    rpcCache.set(cacheKey, { result: r, ts: Date.now(), promise: null });
    return r;
  }).catch(e => {
    rpcCache.delete(cacheKey);
    throw e;
  });
  rpcCache.set(cacheKey, { promise, ts: Date.now(), result: null });
  return promise;
}

// ---- Init ----
function init() {
  if (config.helius?.rpcUrl) {
    connections.push(new Connection(config.helius.rpcUrl, 'confirmed'));
  }
  for (const url of PUBLIC_ENDPOINTS) {
    connections.push(new Connection(url, 'confirmed'));
  }
}

function getConnection() {
  if (!connections.length) init();
  return connections[currentIndex];
}

function rotate() {
  if (connections.length <= 1) return getConnection();
  currentIndex = (currentIndex + 1) % connections.length;
  return connections[currentIndex];
}

async function executeWithFallback(fn, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitForRpcSlot();
    const conn = findFreeEndpoint();
    if (!conn) {
      console.log('[RPC] All endpoints blocked — sleeping 10s');
      await new Promise(r => setTimeout(r, 10000));
      cooldowns.length = 0;
      continue;
    }
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);
      const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('-32429');
      const is403 = msg.includes('403') || msg.includes('Forbidden') || msg.includes('not allowed') || msg.includes('-32052');
      const isTimeout = msg.includes('timeout') || msg.includes('fetch');
      if (is429 || is403 || isTimeout) {
        const idx = connections.indexOf(conn);
        if (idx >= 0) blockEndpoint(idx);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

init();

module.exports = {
  getConnection, rotate, executeWithFallback, connections,
  waitForRpcSlot, cachedRpc
};
