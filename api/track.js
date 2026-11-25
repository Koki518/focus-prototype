'use strict';
// POST /api/track  : the app sends batches of events and finished focus sessions here.
// GET  /api/track  : health check (add ?key=STATS_KEY to also see how many documents are stored).
// Settings (Vercel → Project → Settings → Environment Variables):
//   MONGODB_URI      connection string from MongoDB Atlas (required)
//   MONGODB_DB       database name (optional, default: focus_app)
//   ALLOWED_ORIGINS  sites allowed to call this API, comma separated (optional, default: *)
//   STATS_KEY        any secret word, to read counts from the health check (optional)
const { MongoClient } = require('mongodb');
const { handleTrack } = require('../lib/ingest');

// One connection per running function instance, reused between requests.
let clientPromise = null;
function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return Promise.reject(new Error('MONGODB_URI is not set'));
  if (!clientPromise) {
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
    clientPromise = client.connect().catch((e) => { clientPromise = null; throw e; });
  }
  return clientPromise.then((c) => c.db(process.env.MONGODB_DB || 'focus_app'));
}

module.exports = (req, res) => handleTrack(req, res, getDb, process.env);
