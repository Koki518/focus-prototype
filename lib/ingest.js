'use strict';
// Validates a batch sent by the app and writes it to MongoDB.
// Kept separate from the database connection so it can be tested with a fake database.

const MAX_EVENTS = 200;
const MAX_SESSIONS = 20;
const MAX_BODY_BYTES = 256 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const TYPE_RE = /^[a-z0-9_]{1,40}$/;

// Fields of a focus session record (same columns as the app's CSV export).
const SESSION_NUMBERS = ['planned_min', 'focused_min', 'pickups', 'pickups_per_hour', 'longest_uninterrupted_min',
  'avg_uninterrupted_min', 'focus_stretches', 'self_rating', 'test_speed'];
const SESSION_STRINGS = ['start_time', 'end_time', 'name', 'mode', 'room', 'ended_early', 'penalty', 'sensor', 'app_version'];

class BadRequest extends Error {}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : undefined; }
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Only small, flat objects of numbers / booleans / short strings are kept.
function cleanProps(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(p)) {
    if (n >= 20) break;
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
    else continue;
    n += 1;
  }
  return n ? out : undefined;
}

function normalize(raw, now) {
  let b = raw;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    if (b.length > MAX_BODY_BYTES) throw new BadRequest('body too large');
    try { b = JSON.parse(b); } catch (e) { throw new BadRequest('body is not valid JSON'); }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadRequest('body must be a JSON object');

  const userId = str(b.userId, 64);
  if (!userId || !ID_RE.test(userId)) throw new BadRequest('invalid userId');
  const ctx = {
    userId,
    appSessionId: str(b.appSessionId, 40) || null,
    appVersion: str(b.appVersion, 20) || null,
    platform: str(b.platform, 20) || null,
    demo: b.demo === true,
    testSpeed: num(b.testSpeed) || 1,
  };
  const name = str(b.name, 24);
  const received = new Date(now);

  const events = [];
  for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object') continue;
    const id = str(e.id, 40), type = str(e.type, 40);
    if (!id || !EVENT_ID_RE.test(id) || !type || !TYPE_RE.test(type)) continue;
    let t = Number(e.t);
    if (!Number.isFinite(t) || t < 1.5e12 || t > now + 864e5) t = now;    // missing or impossible phone clock
    const doc = {
      _id: userId + ':' + id,            // the same event sent twice is stored once
      userId, type,
      clientTs: new Date(t), receivedAt: received,
      appSessionId: ctx.appSessionId, appVersion: ctx.appVersion, platform: ctx.platform,
      demo: ctx.demo, testSpeed: ctx.testSpeed,
    };
    const screen = str(e.screen, 30), target = str(e.target, 60), label = str(e.label, 60), props = cleanProps(e.props);
    if (screen) doc.screen = screen;
    if (target) doc.target = target;
    if (label) doc.label = label;
    if (props) doc.props = props;
    events.push(doc);
  }

  const sessions = [];
  for (const r of (Array.isArray(b.sessions) ? b.sessions : []).slice(0, MAX_SESSIONS)) {
    if (!r || typeof r !== 'object') continue;
    const sid = str(r.session_id, 40);
    if (!sid || !/^[A-Za-z0-9_-]{4,40}$/.test(sid)) continue;
    const doc = { session_id: sid, userId };
    for (const k of SESSION_NUMBERS) if (k in r) doc[k] = num(r[k]);
    for (const k of SESSION_STRINGS) if (k in r) doc[k] = str(String(r[k] == null ? '' : r[k]), 80);
    doc.demo = ctx.demo;
    sessions.push({ _id: userId + ':' + sid, doc });
  }

  return { ctx, name, events, sessions, received };
}

const indexesDone = new WeakSet();
async function ensureIndexes(db) {
  if (indexesDone.has(db)) return;
  indexesDone.add(db);
  try {
    await Promise.all([
      db.collection('events').createIndex({ userId: 1, clientTs: 1 }),
      db.collection('events').createIndex({ type: 1, clientTs: 1 }),
      db.collection('sessions').createIndex({ userId: 1, updatedAt: 1 }),
      db.collection('users').createIndex({ lastSeenAt: -1 }),
    ]);
  } catch (e) { indexesDone.delete(db); console.error('index creation failed', e.message); }
}

function isOnlyDuplicates(err) {
  if (!err) return false;
  if (err.code === 11000 && !err.writeErrors) return true;
  const list = [].concat(err.writeErrors || []);
  return list.length > 0 && list.every((w) => (w.code != null ? w.code : w.err && w.err.code) === 11000);
}

async function writeBatch(db, batch) {
  const { ctx, name, events, sessions, received } = batch;
  ensureIndexes(db);   // not awaited: it only needs to happen once

  const set = { lastSeenAt: received, appVersion: ctx.appVersion, platform: ctx.platform };
  if (name) set.name = name;
  await db.collection('users').updateOne(
    { _id: ctx.userId },
    { $set: set, $setOnInsert: { createdAt: received, firstAppVersion: ctx.appVersion }, $inc: { batches: 1, eventCount: events.length } },
    { upsert: true },
  );

  let inserted = 0, duplicates = 0;
  if (events.length) {
    try {
      const r = await db.collection('events').insertMany(events, { ordered: false });
      inserted = r.insertedCount;
    } catch (err) {
      if (!isOnlyDuplicates(err)) throw err;
      inserted = err.insertedCount != null ? err.insertedCount : (err.result && err.result.insertedCount) || 0;
    }
    duplicates = events.length - inserted;
  }

  for (const s of sessions) {
    await db.collection('sessions').updateOne(
      { _id: s._id },
      { $set: { ...s.doc, updatedAt: received }, $setOnInsert: { createdAt: received } },
      { upsert: true },
    );
  }
  return { inserted, duplicates, sessions: sessions.length };
}

function setCors(req, res, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers && req.headers.origin;
  if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && allowed.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readBody(req) {
  // On Vercel, req.body is already filled in (a string for text/plain, an object for JSON, null if empty).
  if ('body' in req) {
    let b;
    try { b = req.body; } catch (e) { throw new BadRequest('body could not be read'); }
    if (b !== undefined) return b;
  }
  if (typeof req.on !== 'function') return undefined;
  // Plain Node.js server: read the stream ourselves.
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new BadRequest('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function queryParam(req, key) {
  if (req.query && typeof req.query[key] === 'string') return req.query[key];
  try { return new URL(req.url || '', 'http://x').searchParams.get(key); } catch (e) { return null; }
}

async function handleTrack(req, res, getDb, env = {}) {
  setCors(req, res, env);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (req.method === 'GET') {
    // Health check: is the database reachable? With ?key=STATS_KEY, also returns counts.
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      const out = { ok: true, database: 'connected' };
      if (env.STATS_KEY && queryParam(req, 'key') === env.STATS_KEY) {
        const [users, events, sessions] = await Promise.all(['users', 'events', 'sessions'].map((c) => db.collection(c).countDocuments({})));
        out.counts = { users, events, sessions };
      }
      return send(res, 200, out);
    } catch (e) {
      console.error('health check failed', e.message);
      return send(res, 503, { ok: false, database: 'unreachable' });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'use POST' });

  let batch;
  try { batch = normalize(await readBody(req), Date.now()); }
  catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { ok: false, error: e.message });
    throw e;
  }
  try {
    const db = await getDb();
    const result = await writeBatch(db, batch);
    return send(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error('write failed', e.message);
    return send(res, 500, { ok: false, error: 'database error' });
  }
}

module.exports = { handleTrack, normalize, writeBatch, BadRequest, MAX_EVENTS };
