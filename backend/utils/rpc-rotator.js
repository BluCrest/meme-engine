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
  console.log(`[RPCRotator] Rotated to endpoint ${currentIndex + 1}/${connections.length}`);
  return connections[currentIndex];
}

async function executeWithFallback(fn, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const conn = getConnection();
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      if (err.message?.includes('429') || err.message?.includes('rate limit') || err.message?.includes('timeout') || err.message?.includes('fetch')) {
        rotate();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

init();

module.exports = { getConnection, rotate, executeWithFallback, connections };
