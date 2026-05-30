require('dotenv').config();

module.exports = {
  helius: {
    apiKey: process.env.HELIUS_API_KEY,
    rpcUrl: process.env.SOLANA_RPC_URL,
    privateKey: process.env.SOLANA_WALLET_PRIVATE_KEY
  },
  x: {
    bearerToken: process.env.X_BEARER_TOKEN,
    apiKey: process.env.X_API_KEY,
    apiSecret: process.env.X_API_SECRET
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY
  },
  mongodb: {
    uri: process.env.MONGODB_URI,
    dbName: process.env.MONGODB_DB_NAME || 'meme_engine'
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    apiId: process.env.TG_API_ID,
    apiHash: process.env.TG_API_HASH,
    sessionString: process.env.TG_SESSION_STRING
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY
  },
  baseScan: {
    apiKey: process.env.BASESCAN_API_KEY
  },
  config: {
    minApeProbability: parseInt(process.env.MIN_APE_PROBABILITY) || 55,
    autoExecuteProbability: parseInt(process.env.AUTO_EXECUTE_PROBABILITY) || 80,
    maxSolPerTrade: parseFloat(process.env.MAX_SOL_PER_TRADE) || 0.1,
    alertCooldownMinutes: parseInt(process.env.ALERT_COOLDOWN_MINUTES) || 5,
    divergenceCheckInterval: parseInt(process.env.DIVERGENCE_CHECK_INTERVAL) || 120
  },
  paperTrading: process.env.PAPER_TRADING === 'true',
  copyTrade: {
    targetWallets: (process.env.COPY_TRADE_WALLETS || '').split(',').filter(Boolean),
    maxSolPerCopy: parseFloat(process.env.COPY_MAX_SOL) || 0.05
  }
};