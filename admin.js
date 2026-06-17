// Admin/session helpers: password generation, HTTP Basic auth check, and the
// read-only session/activity snapshot served to the admin page. Kept as pure
// functions (no server state) so they can be unit-tested in isolation.

const crypto = require('crypto');
const fs = require('fs');

// A short, URL-safe random password (auto-generated once per server start unless
// ADMIN_PASS is provided via the environment).
function genPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars
}

// Resolve the admin password, persisting it so it survives container redeploys:
//   1. an explicit ADMIN_PASS env var always wins;
//   2. otherwise read ADMIN_PASS from the .env file at `envPath`;
//   3. otherwise generate one and append it to that file (created if missing).
// Put `envPath` on a mounted volume (e.g. DATA_DIR) for the value to persist.
function loadOrCreateAdminPass(envPath) {
  if (process.env.ADMIN_PASS) return { pass: process.env.ADMIN_PASS, source: 'env' };

  const fromFile = readEnvVar(envPath, 'ADMIN_PASS');
  if (fromFile) return { pass: fromFile, source: 'file' };

  const pass = genPassword();
  try {
    let existing = '';
    try { existing = fs.readFileSync(envPath, 'utf8'); } catch { /* no file yet */ }
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(envPath, `${existing}${sep}ADMIN_PASS=${pass}\n`, { mode: 0o600 });
    return { pass, source: 'generated' };
  } catch (e) {
    return { pass, source: 'ephemeral', error: e.message };  // couldn't persist
  }
}

// Read a single KEY=value from a .env-style file. Returns null if absent.
function readEnvVar(envPath, key) {
  let txt;
  try { txt = fs.readFileSync(envPath, 'utf8'); } catch { return null; }
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m && m[1].trim() ? m[1].trim() : null;
}

// Constant-time string compare (false on any length mismatch).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Validate an "Authorization: Basic …" header against the admin credentials.
function checkAuth(header, user, pass) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

// A flat summary of one room's live state for the admin view.
function sessionSummary(room, now = Date.now()) {
  const w = room.world;
  const assets = {};
  let carrying = 0;
  for (const v of w.vehicles) {
    assets[v.type] = (assets[v.type] || 0) + 1;
    carrying += v.load || 0;
  }
  const players = room.clients ? room.clients.size : 0;
  return {
    code: room.code,
    createdAt: room.createdAt,
    ageMs: Math.max(0, now - (room.createdAt || now)),
    players,
    peakPlayers: room.peakClients || 0,
    totalJoins: room.totalJoins || 0,
    emptySince: room.emptySince || null,
    credit: w.credit,
    vehicleCount: w.vehicles.length,
    assets,
    carrying: Math.round(carrying),
  };
}

// The full payload for the admin page: live sessions, ended-session history, and
// a recent activity log — newest first.
function buildAdminData({ rooms, sessionLog = [], eventLog = [], graceMs = 0, now = Date.now() }) {
  const active = [];
  for (const room of rooms.values()) {
    const s = sessionSummary(room, now);
    s.status = s.players > 0 ? 'active' : 'idle';
    active.push(s);
  }
  active.sort((a, b) => b.createdAt - a.createdAt);
  return {
    now,
    graceMs,
    activeCount: active.length,
    playerCount: active.reduce((n, s) => n + s.players, 0),
    active,
    history: sessionLog.slice(-200).reverse(),
    events: eventLog.slice(-200).reverse(),
  };
}

module.exports = { genPassword, loadOrCreateAdminPass, readEnvVar, safeEqual, checkAuth, sessionSummary, buildAdminData };
