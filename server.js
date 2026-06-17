const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { World } = require('./game/world');
const { genPassword, checkAuth, sessionSummary, buildAdminData } = require('./admin');

const app = express();
const PORT = process.env.PORT || 3200;

// ── Admin auth (username "admin", auto-generated password) ────────────────────
const ADMIN_USER = 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || genPassword();   // stable if set via env
function adminGuard(req, res, next) {
  if (checkAuth(req.headers.authorization, ADMIN_USER, ADMIN_PASS)) return next();
  res.set('WWW-Authenticate', 'Basic realm="mine-sim admin", charset="UTF-8"');
  res.status(401).send('Authentication required');
}
app.get('/admin', adminGuard, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin/api/sessions', adminGuard, (req, res) =>
  res.json(buildAdminData({ rooms, sessionLog, eventLog, graceMs: ROOM_GRACE_MS })));

// Grant credit to a room from the admin page (+100k / +500k buttons).
app.post('/admin/api/credit', adminGuard, express.json(), (req, res) => {
  const { code, amount } = req.body || {};
  const room = typeof code === 'string' ? rooms.get(code.toUpperCase()) : null;
  if (!room) return res.status(404).json({ error: 'room not found' });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: 'bad amount' });
  const credit = room.world.addCredit(amt);
  // Push the new balance to connected clients without touching the road network.
  roomBroadcast(room, { t: 'live', vehicles: [], blocks: [], credit });
  logEvent('credit', room.code, { amount: amt, credit });
  console.log(`[credit] room=${room.code} +${amt} -> ${credit}`);
  res.json({ ok: true, code: room.code, credit });
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Rooms (Option B: dedicated instanced games) ───────────────────────────────
// Each room is an isolated World with a shareable code. A client joins a room
// (create one or enter a code); ticks and broadcasts are per-room.
const rooms = new Map();          // code → { code, world, clients:Set<ws>, emptySince, lastDebugStr, createdAt, peakClients, totalJoins }
const MAX_ROOMS = 500;
const ROOM_GRACE_MS = 2 * 60 * 60 * 1000;  // keep an empty room this long (reconnects)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

// Admin bookkeeping: ended sessions and a recent activity log (both in-memory,
// reset on restart). Bounded so a long-lived server doesn't grow unbounded.
const sessionLog = [];            // ended-session summaries
const eventLog = [];              // { at, type, code, ... } activity entries
function logEvent(type, code, extra = {}) {
  eventLog.push({ at: Date.now(), type, code, ...extra });
  if (eventLog.length > 500) eventLog.shift();
}

function genCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (rooms.has(c));
  return c;
}

function createRoom() {
  const now = Date.now();
  const room = {
    code: genCode(), world: new World(), clients: new Set(),
    emptySince: now, lastDebugStr: null,
    createdAt: now, peakClients: 0, totalJoins: 0,
  };
  rooms.set(room.code, room);
  logEvent('create', room.code);
  return room;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function roomBroadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function joinRoom(ws, room) {
  leaveRoom(ws);
  ws.room = room;
  room.clients.add(ws);
  room.emptySince = null;
  room.totalJoins = (room.totalJoins || 0) + 1;
  room.peakClients = Math.max(room.peakClients || 0, room.clients.size);
  logEvent('join', room.code, { players: room.clients.size });
  send(ws, { t: 'joined', room: room.code });
  send(ws, { t: 'state', state: room.world.fullState() });
  console.log(`[join] room=${room.code} clients=${room.clients.size} roads=${room.world.roads.serialize().length}`);
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  ws.room = null;
  if (room.clients.size === 0) room.emptySince = Date.now();
  logEvent('leave', room.code, { players: room.clients.size });
  console.log(`[leave] room=${room.code} clients=${room.clients.size}`);
}

// ── Connection / message routing ──────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    // Lobby messages (no room required yet).
    if (m.t === 'create') {
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'joinError', reason: 'server full' });
      joinRoom(ws, createRoom());
      return;
    }
    if (m.t === 'join') {
      const room = typeof m.room === 'string' ? rooms.get(m.room.toUpperCase()) : null;
      if (!room) return send(ws, { t: 'joinError', reason: 'room not found' });
      joinRoom(ws, room);
      return;
    }

    // Everything else is scoped to the client's room.
    const room = ws.room;
    if (!room) return;
    const world = room.world;
    switch (m.t) {
      case 'drill': {
        const r = world.drill(m.x, m.y);
        send(ws, { t: 'drilled', x: m.x, y: m.y, block: r.block || null, credit: r.credit, error: r.error });
        break;
      }
      case 'roads': {
        const before = world.roads.serialize().length;
        const incoming = Array.isArray(m.cells) ? m.cells.length : -1;
        world.setRoads(m.cells);
        const after = world.roads.serialize().length;
        if (before > 0 && after === 0) {
          console.warn(`[roads] WIPED room=${room.code} clients=${room.clients.size} before=${before} incoming=${incoming}`);
        } else {
          console.log(`[roads] room=${room.code} ${before}->${after} (incoming=${incoming})`);
        }
        const out = JSON.stringify({ t: 'roads', cells: world.roads.serialize() });
        for (const c of room.clients) if (c !== ws && c.readyState === c.OPEN) c.send(out);
        break;
      }
      case 'control': if (typeof m.label === 'string') world.control(m.label, { dir: m.dir, release: m.release }); break;
      case 'assign':  if (typeof m.truck === 'string') world.assign(m.truck, m.shovel || null); break;
      case 'debug':   if (typeof m.label === 'string') world.setDebug(m.label, !!m.on); break;
      case 'select':  if (typeof m.label === 'string') world.select(m.label, !!m.on); break;
      case 'buy': {
        const r = world.buyAsset(m.id);
        send(ws, { t: 'bought', id: m.id, ok: r.ok, error: r.error, credit: r.credit, label: r.label });
        // Broadcast ONLY the new vehicle (not a full state) so a purchase never
        // reloads/clobbers the roads on other clients. Credit propagates via live.
        if (r.ok) roomBroadcast(room, { t: 'vehicle', vehicle: r.vehicle });
        console.log(`[buy] room=${room.code} id=${m.id} ok=${!!r.ok}`);
        break;
      }
      case 'reset': world.reset(); roomBroadcast(room, { t: 'state', state: world.fullState() }); logEvent('reset', room.code); console.log(`[reset] room=${room.code}`); break;
      case 'resizeParking': {
        if (m.rect && typeof m.rect === 'object') {
          const r = world.resizeParking(m.rect);
          roomBroadcast(room, { t: 'state', state: world.fullState() });
          console.log(`[parking] room=${room.code} -> ${JSON.stringify(r)}`);
        }
        break;
      }
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

// ── Simulation + broadcast loop (per room) ────────────────────────────────────
const TICK_HZ = 30;
const NET_EVERY = 2;            // broadcast every 2nd tick → 15 Hz
const DT = 1 / TICK_HZ;
let tickN = 0;
setInterval(() => {
  try {
    const doNet = (++tickN % NET_EVERY === 0);
    for (const room of rooms.values()) {
      if (room.clients.size === 0) continue;     // frozen while nobody is connected
      room.world.tick(DT);
      if (!doNet) continue;

      const live = room.world.liveDelta();
      const debug = room.world.hasDebug() ? room.world.debugPaths() : {};
      const debugStr = JSON.stringify(debug);
      const debugChanged = debugStr !== room.lastDebugStr;
      room.lastDebugStr = debugStr;
      if (!live && !debugChanged) continue;

      const msg = { t: 'live', vehicles: live?.vehicles || [], blocks: live?.blocks || [] };
      if (live && 'credit' in live) msg.credit = live.credit;
      if (debugChanged || Object.keys(debug).length) msg.debug = debug;
      roomBroadcast(room, msg);
    }
  } catch (err) {
    console.error('[tick] error (continuing):', err);
  }
}, 1000 / TICK_HZ);

// Heartbeat: keep WebSockets alive through proxies (Traefik idle timeout).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.warn(`[hb] terminating unresponsive ws (room=${ws.room?.code ?? '-'})`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

// Reap rooms that have been empty past the grace period.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && room.emptySince && now - room.emptySince > ROOM_GRACE_MS) {
      sessionLog.push({ ...sessionSummary(room, now), status: 'ended', endedAt: now });
      if (sessionLog.length > 300) sessionLog.shift();
      rooms.delete(code);
      logEvent('reap', code);
      console.log(`[reap] room=${code} (empty > grace)`);
    }
  }
}, 60000);

// Never let a stray error kill the process and reset every room.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

server.listen(PORT, () => {
  console.log(`mine-sim running on http://localhost:${PORT}`);
  console.log(`[admin] http://localhost:${PORT}/admin  user=${ADMIN_USER}  pass=${ADMIN_PASS}`);
});
