// Format PnL as x-returns: profit (1.50x), loss (-0.50x)
function formatX(pnlDecimal) {
  if (pnlDecimal >= 0) return (1 + pnlDecimal).toFixed(2) + 'x';
  return pnlDecimal.toFixed(2) + 'x';
}
module.exports = { formatX };
