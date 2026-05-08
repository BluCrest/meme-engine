const { MongoClient } = require('mongodb');
const config = require('../config');

let client;
let db;

async function connect() {
  if (db) return db;

  const uri = config.mongodb?.uri;
  if (!uri) {
    console.warn('[DB] MONGODB_URI not set, using mock DB');
    // Return a mock DB for development
    return getMockDb();
  }

  try {
    // Extract database name from URI path (e.g. /clipscene) so it always matches
    const dbMatch = uri.match(/\/([^/?]+)(\?|$)/);
    const uriDbName = dbMatch ? dbMatch[1] : null;
    const effectiveDbName = uriDbName || config.mongodb.dbName || 'meme_engine';

    // Strip db name from URI to avoid case conflicts
    const cleanUri = uri.replace(/\/[^/?]+(\?|$)/, '/$1');
    client = new MongoClient(cleanUri, { dbName: effectiveDbName });
    await client.connect();
    db = client.db();
    console.log(`[DB] MongoDB connected — database: ${effectiveDbName}`);
    return db;
  } catch (e) {
    console.error('[DB] Connection failed:', e.message);
    return getMockDb();
  }
}

function getMockDb() {
  if (db) return db;
  // Simple in-memory mock for development
  const collections = {};
  db = {
    collection: (name) => {
      if (!collections[name]) {
        collections[name] = {
          data: [],
          find: function(query = {}) {
            return {
              toArray: () => {
                const results = collections[name].data.filter(item => {
                  return Object.keys(query).every(key => {
                    if (key === '_id') return true; // Skip _id filter for mock
                    if (typeof query[key] === 'object') {
                      if (query[key].$gte !== undefined) return item[key] >= query[key].$gte;
                      if (query[key].$lte !== undefined) return item[key] <= query[key].$lte;
                    }
                    return item[key] === query[key];
                  });
                });
                return results;
              },
              sort: function(sortObj) {
                return {
                  toArray: () => {
                    return this.toArray().then(results => {
                      const key = Object.keys(sortObj)[0];
                      const dir = sortObj[key];
                      return results.sort((a, b) => dir * (a[key] > b[key] ? 1 : -1));
                    });
                  }
                };
              },
              findOne: function(query) {
                return this.toArray().then(results => results[0] || null);
              }
            };
          },
          findOne: function(query) {
            return this.find(query).findOne(query);
          },
          updateOne: function(query, update, options) {
            const col = collections[name];
            const idx = col.data.findIndex(item => {
              return Object.keys(query).every(key => item[key] === query[key]);
            });
            if (idx >= 0) {
              Object.assign(col.data[idx], update.$set || update);
            } else if (options?.upsert) {
              col.data.push({ ...query, ...(update.$set || update) });
            }
            return Promise.resolve({});
          },
          updateMany: function(query, update) {
            return Promise.resolve({});
          },
          insertOne: function(doc) {
            if (!collections[name]) collections[name] = { data: [] };
            collections[name].data.push(doc);
            return Promise.resolve({});
          },
          insertMany: function(docs) {
            if (!collections[name]) collections[name] = { data: [] };
            collections[name].data.push(...docs);
            return Promise.resolve({});
          }
        };
      }
      return collections[name];
    }
  };
  return db;
}

async function getPaperTrading() {
  const db = await connect();
  const doc = await db.collection('settings').findOne({ key: 'paperTrading' });
  return doc?.value ?? false;
}

async function setPaperTrading(val) {
  const db = await connect();
  await db.collection('settings').updateOne(
    { key: 'paperTrading' },
    { $set: { value: val, updatedAt: new Date() } },
    { upsert: true }
  );
}

module.exports = {
  connect,
  getDb: () => {
    if (!db) throw new Error('DB not connected. Call connect() first.');
    return db;
  },
  getToken: async (address) => {
    const db = await connect();
    return db.collection('tokens').findOne({ address });
  },
  upsertToken: async (token) => {
    const db = await connect();
    return db.collection('tokens').updateOne(
      { address: token.address },
      { $set: token },
      { upsert: true }
    );
  },
  getDevProfile: async (wallet) => {
    const db = await connect();
    return db.collection('dev_profiles').findOne({ wallet_address: wallet });
  },
  upsertDevProfile: async (profile, launches) => {
    const db = await connect();
    await db.collection('dev_profiles').updateOne(
      { wallet_address: profile.walletAddress },
      { $set: profile },
      { upsert: true }
    );
    if (launches?.length) {
      await db.collection('dev_launches').insertMany(launches);
    }
  },
  updateDevProfileCrossChain: async (solanaWallet, crossChainData) => {
    const db = await connect();
    return db.collection('dev_profiles').updateOne(
      { wallet_address: solanaWallet },
      { $set: {
        eth_wallet: crossChainData.ethWallet,
        base_wallet: crossChainData.baseWallet,
        cross_chain_rugs: crossChainData.crossChainRugs,
        cross_chain_flag: crossChainData.crossChainFlag,
        updated_at: new Date()
      }},
      { upsert: true }
    );
  },
  insertPrelaunchDetection: async (detection) => {
    const db = await connect();
    return db.collection('prelaunch_detections').insertOne(detection);
  },
  insertDivergenceSignal: async (signal) => {
    const db = await connect();
    return db.collection('divergence_signals').insertOne(signal);
  },
  insertTrade: async (trade) => {
    const db = await connect();
    return db.collection('trades').insertOne(trade);
  },
  getOpenPositions: async () => {
    const db = await connect();
    return db.collection('positions').find({ status: 'open' }).toArray();
  },
  upsertPosition: async (position) => {
    const db = await connect();
    return db.collection('positions').updateOne(
      { token_address: position.token_address },
      { $set: position },
      { upsert: true }
    );
  },
  updateHighestPrice: async (id, price) => {
    const db = await connect();
    return db.collection('positions').updateOne(
      { _id: id },
      { $set: { highest_price: price } }
    );
  },
  markExitTierHit: async (id, threshold) => {
    const db = await connect();
    const key = `sold_${threshold}`;
    return db.collection('positions').updateOne(
      { _id: id },
      { $set: { [key]: true } }
    );
  },
  getPaperTrading,
  setPaperTrading
};
