const { getTopHolders: fetchHolders } = require('../utils/holders');

async function getTopHolders(tokenAddress, limit = 10) {
  return fetchHolders(tokenAddress, limit);
}

async function getFundingSource(walletAddress, depth = 2) {
  try {
    // TODO: Use Helius to trace funding source
    // const txs = await connection.getSignaturesForAddress(new PublicKey(walletAddress), { limit: 50 });
    // Find initial funding tx -> trace to source
    return { wallet: walletAddress, source: null }; // placeholder
  } catch (err) {
    console.error('[Cluster] Error tracing funding:', err.message);
    return { wallet: walletAddress, source: null };
  }
}

function groupByFundingSource(fundingSources) {
  const groups = {};
  fundingSources.forEach(f => {
    const key = f.source || f.wallet;
    if (!groups[key]) groups[key] = { wallets: [] };
    groups[key].wallets.push(f.wallet);
  });
  return Object.values(groups);
}

async function analyzeWalletClusters(tokenAddress) {
  const topHolders = await getTopHolders(tokenAddress, 10);
  const fundingSources = await Promise.all(
    topHolders.map(h => getFundingSource(h.address, 2))
  );

  const clusters = groupByFundingSource(fundingSources);
  const largestCluster = Math.max(...clusters.map(c => c.wallets.length));

  const clusterRisk =
    largestCluster >= 7 ? 'high' :
    largestCluster >= 4 ? 'medium' : 'low';

  return {
    clusterRisk,
    largestClusterSize: largestCluster,
    clusterDetails: clusters
  };
}

module.exports = { analyzeWalletClusters };