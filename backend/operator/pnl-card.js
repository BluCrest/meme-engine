const config = require('../config');
const db = require('../database/db');

function formatMC(mc) {
  if (!mc) return '$0';
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(1)}M`;
  if (mc >= 1e3) return `$${(mc / 1e3).toFixed(1)}K`;
  return `$${mc.toFixed(0)}`;
}

function getOutcomeEmoji(outcome) {
  switch(outcome) {
    case 'win': return '🎉';
    case 'loss': return '💔';
    case 'rug': return '🚨';
    case 'moonshot': return '🚀🚀🚀';
    default: return '📊';
  }
}

async function generatePnLCard(tradeOrPosition) {
  // Fetch full trade context
  const token = await db.getToken(tradeOrPosition.token_address);
  const report = await db.getDb().collection('intelligence_reports')
    .findOne({ token_address: tradeOrPosition.token_address });

  const entryMC = tradeOrPosition.entry_mc || tradeOrPosition.mc_at_trade || 0;
  const exitMC = tradeOrPosition.exit_mc || tradeOrPosition.mc_at_trade || 0;
  const solInvested = tradeOrPosition.sol_amount || tradeOrPosition.sol_invested || 0;
  const returnMultiple = exitMC > 0 && entryMC > 0 ? exitMC / entryMC : 0;

  const pnlPercent = entryMC > 0 ? ((exitMC - entryMC) / entryMC) * 100 : 0;
  const solReturn = solInvested * (returnMultiple || 0);
  const netSol = solReturn - solInvested;

  const apeProb = report?.ape_probability_at_entry || token?.ape_probability || 0;
  const outcome = report?.outcome || (pnlPercent >= 100 ? 'win' : pnlPercent < -50 ? 'loss' : 'unknown');

  const emoji = getOutcomeEmoji(outcome);

  const card = `
${emoji} *PnL REPORT: $${token?.symbol || 'UNKNOWN'}*
━━━━━━━━━━━━━━━━━━━━
📍 *CAPITAL USED:* ${solInvested.toFixed(3)} SOL
📈 *RETURN:* ${returnMultiple.toFixed(2)}x (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(0)}%)
💰 *SOL GAIN/LOSS:* ${netSol >= 0 ? '+' : ''}${netSol.toFixed(3)} SOL

🎯 *PREDICTION vs REALITY*
• Ape Probability at Entry: *${apeProb}%*
• Actual Outcome: *${outcome.toUpperCase()}*
• Prediction Accuracy: ${apeProb >= 55 && pnlPercent > 0 ? '✅ CORRECT' : apeProb < 55 && pnlPercent < 0 ? '✅ CORRECT (avoided)' : '❌ WRONG'}

━━━━━━━━━━━━━━━━━━━━
📊 *EVIDENCE AT ENTRY*
• Safety Score: ${report?.safety_score_at_entry || token?.safety_score || 0}/100
• Social Score: ${report?.social_score_at_entry || token?.social_score || 0}/100
• Smart Money: ${report?.smart_money_score_at_entry || token?.smart_money_score || 0}/100
• Dev Type: ${token?.dev_type || 'unknown'}
• Bundle Detected: ${report?.bundle_detected ? '⚠️ YES' : '✅ NO'}

🔍 *DEEPSEEK REASONING*
${report?.notes || token?.reasoning || 'N/A'}

━━━━━━━━━━━━━━━━━━━━
*Entry MC:* ${formatMC(entryMC)} → *Exit MC:* ${formatMC(exitMC)}
━━━━━━━━━━━━━━━━━━━━
`;

  return card.trim();
}

async function sendPnLCard(chatId, tradeOrPosition) {
  const { bot } = require('./telegram-bot');
  const card = await generatePnLCard(tradeOrPosition);

  await bot.sendMessage(chatId || config.telegram.chatId, card, {
    parse_mode: 'Markdown'
  });
}

// Generate a summary PnL card for all positions
async function generatePortfolioSummary() {
  const positions = await db.getOpenPositions();
  const closedTrades = await db.getDb().collection('trades')
    .find({ action: 'sell' })
    .sort({ timestamp: -1 })
    .limit(20)
    .toArray();

  let totalInvested = 0;
  let totalReturn = 0;
  let wins = 0, losses = 0;

  for (const trade of closedTrades) {
    totalInvested += trade.sol_amount || 0;
    const returnMultiple = trade.price_at_trade && trade.mc_at_trade
      ? trade.price_at_trade / trade.mc_at_trade : 0;
    totalReturn += (trade.sol_amount || 0) * returnMultiple;

    if (returnMultiple > 1) wins++;
    else losses++;
  }

  const pnl = totalReturn - totalInvested;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

  return `
💼 *PORTFOLIO SUMMARY*
━━━━━━━━━━━━━━━━━━━━
📊 *PERFORMANCE*
• Total Trades: ${closedTrades.length}
• Win Rate: ${winRate.toFixed(0)}% (${wins}W / ${losses}L)
• Invested: ${totalInvested.toFixed(3)} SOL
• Current Value: ${totalReturn.toFixed(3)} SOL
• Net PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL

📈 *OPEN POSITIONS:* ${positions.length}
${positions.map(p => `• ${p.token_address}: ${p.remaining_ratio * 100}% remaining`).join('\n') || 'None'}

━━━━━━━━━━━━━━━━━━━━
`;
}

module.exports = { generatePnLCard, sendPnLCard, generatePortfolioSummary };