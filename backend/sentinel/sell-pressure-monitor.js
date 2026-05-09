const db = require('../database/db');
const { rateLimitedFetch } = require('../utils/dex-rate-limit');

const SELL_HISTORY = new Map();

async function fetchDexScreenerPair(tokenAddress) {
  try {
    const res = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.pairs?.[0] || null;
  } catch (_) { return null; }
}

async function fetchDexPaprikaActivity(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexpaprika.com/networks/solana/tokens/${tokenAddress}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.summary || null;
  } catch (_) { return null; }
}

function checkSellPressure(pair, paprika) {
  const txns = pair?.txns || {};
  const h1Buys = txns.h1?.buys || 0;
  const h1Sells = txns.h1?.sells || 0;
  const h1Total = h1Buys + h1Sells;
  if (h1Total < 5) return null;

  const sellRatio = h1Sells / h1Total;
  const vol1h = pair.volume?.h1 || 0;
  const vol5m = pair.volume?.m5 || 0;

  const results = [];

  if (sellRatio > 0.65 && h1Total >= 10) {
    results.push({
      triggered: true,
      severity: 'high',
      reason: 'sell_dominated',
      sellRatio,
      detail: `${(sellRatio * 100).toFixed(0)}% sells in 1h (${h1Sells}/${h1Total} txns)`,
      message: `🛑 *SELL DOMINATED* — ${(sellRatio * 100).toFixed(0)}% sells in 1h`
    });
  }

  if (h1Total >= 20 && h1Sells > h1Buys * 1.5) {
    results.push({
      triggered: true,
      severity: 'high',
      reason: 'sell_volume_surge',
      sellRatio,
      detail: `${h1Sells}s vs ${h1Buys}b (${(h1Sells / Math.max(h1Buys, 1)).toFixed(1)}x sells)`,
      message: `📉 *SELL SURGE* — ${h1Sells}s vs ${h1Buys}b in 1h`
    });
  }

  if (paprika) {
    const m5 = paprika['5m'] || {};
    const m5Sells = m5.sells || 0;
    const m5Buys = m5.buys || 0;
    const m5Total = m5Buys + m5Sells;
    let m5SellRatio = 0;

    if (m5Total >= 3) {
      m5SellRatio = m5Sells / m5Total;
      if (m5SellRatio > 0.7) {
        results.push({
          triggered: true,
          severity: 'critical',
          reason: 'active_dump_5m',
          sellRatio: m5SellRatio,
          detail: `${(m5SellRatio * 100).toFixed(0)}% sells in 5min (${m5Buys}B/${m5Sells}S)`,
          message: `🔥 *ACTIVE DUMP* — ${(m5SellRatio * 100).toFixed(0)}% sells in last 5min`
        });
      }
    }

    if (vol5m > 0 && m5Total >= 5 && m5SellRatio > 0.6) {
      results.push({
        triggered: true,
        severity: 'critical',
        reason: 'panic_selling',
        sellRatio: m5SellRatio,
        detail: `${m5Total} txns/5m, ${(m5SellRatio * 100).toFixed(0)}% sells`,
        message: `🚨 *PANIC SELLING* — ${m5Total} txns in 5min, ${(m5SellRatio * 100).toFixed(0)}% sells`
      });
    }
  }

  return results.length > 0 ? results : null;
}

async function checkTokenSellPressure(tokenAddress) {
  const pair = await fetchDexScreenerPair(tokenAddress);
  if (!pair) return null;

  const paprika = await fetchDexPaprikaActivity(tokenAddress);

  const history = SELL_HISTORY.get(tokenAddress) || [];
  const now = Date.now();
  const clean = history.filter(h => now - h.ts < 600000);
  clean.push({ ts: now, sellRatio: paprika ? paprika['5m']?.sells / Math.max(paprika['5m']?.buys + paprika['5m']?.sells, 1) : 0.5 });
  SELL_HISTORY.set(tokenAddress, clean.slice(-10));

  if (clean.length >= 3) {
    const recentRatios = clean.slice(-3).map(h => h.sellRatio);
    const avgSellRatio = recentRatios.reduce((a, b) => a + b, 0) / recentRatios.length;
    if (avgSellRatio > 0.6 && clean.length >= 3) {
      return [{
        triggered: true,
        severity: 'medium',
        reason: 'sustained_sell_pressure',
        sellRatio: avgSellRatio,
        detail: `Avg ${(avgSellRatio * 100).toFixed(0)}% sells over last ${clean.length} checks`,
        message: `⚠️ *SUSTAINED SELLING* — Avg ${(avgSellRatio * 100).toFixed(0)}% sells`
      }];
    }
  }

  return checkSellPressure(pair, paprika);
}

module.exports = { checkTokenSellPressure, checkSellPressure };
