// Multi-core mode (opt-in via WORKERS>1). The PRIMARY is a thin TCP gateway on
// PORT that routes each connection to a worker by the room code in the request
// URL (`?room=CODE`) — the code's first char encodes its owning worker, so
// routing is stateless and stable across restarts. Each worker runs a full
// server (its own rooms + SQLite DB) on a private localhost port. The primary
// also serves /admin*, aggregating the workers' data over IPC.
//
// This keeps every room's authoritative sim on a single worker (required — a
// World can't be ticked by two processes) while spreading rooms across cores.
//
//   WORKERS=4 node server.js

const cluster = require('cluster');
const net = require('net');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { createServer } = require('./app');
const { workerForCode } = require('./rooms');
const { roomBroadcast } = require('./transport');
const { loadOrCreateAdminPass, checkAuth, buildAdminData } = require('../admin');

const ROOT = path.join(__dirname, '..');
const PORT = +(process.env.PORT || 3200);
const DATA_DIR = process.env.DATA_DIR || ROOT;
const WORKERS = Math.max(2, Math.min(31, +process.env.WORKERS || os.availableParallelism()));

function start() { cluster.isPrimary ? primary() : worker(); }

// ── Worker: a full server on a private localhost port + IPC handlers ──────────
function worker() {
  const id = +process.env.WORKER_ID;
  const inst = createServer({
    shard: { id, count: WORKERS },
    dbFile: path.join(DATA_DIR, `minesim-w${id}.db`),
    adminPass: process.env.ADMIN_PASS,           // shared (resolved by the primary)
  });
  // exclusive:true is REQUIRED — without it the cluster module shares one socket
  // across all workers (round-robin), so every worker would "listen" on the same
  // port and the gateway could not target a specific worker. We need a private
  // port per worker to route each room to its owner.
  inst.server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
    if (process.env.CLUSTER_DEBUG) console.log(`[w${id}] listening on ${inst.server.address().port} shard{${id}/${WORKERS}}`);
    process.send({ t: 'listening', port: inst.server.address().port });
  });

  process.on('message', (m) => {
    if (!m || !m.t) return;
    if (m.t === 'admin-data') {
      const data = buildAdminData({ rooms: inst.rooms.rooms, sessionLog: inst.rooms.sessionLog, eventLog: inst.rooms.eventLog, graceMs: inst.config.graceMs });
      process.send({ t: 'reply', id: m.id, data });
    } else if (m.t === 'admin-credit') {
      process.send({ t: 'reply', id: m.id, data: grantCredit(inst, m.data) });
    }
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => inst.stop(() => process.exit(0)));
}

function grantCredit(inst, { code, amount } = {}) {
  const room = inst.rooms.get(code);
  if (!room) return { error: 'room not found' };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) return { error: 'bad amount' };
  const credit = room.world.addCredit(amt);
  roomBroadcast(room, { t: 'live', vehicles: [], blocks: [], credit });
  inst.rooms.logEvent('credit', room.code, { amount: amt, credit });
  inst.rooms.markDirty(room);
  return { ok: true, code: room.code, credit };
}

// ── Primary: gateway + admin aggregator ───────────────────────────────────────
function primary() {
  const { pass: ADMIN_PASS } = loadOrCreateAdminPass(path.join(DATA_DIR, '.env'));
  process.env.ADMIN_PASS = ADMIN_PASS;           // inherited by every worker

  const workers = [];                            // index → { proc, port, conns }
  const pending = new Map();                      // ipc req id → resolver
  let reqId = 0;

  const fork = (i) => {
    const proc = cluster.fork({ WORKER_ID: i, WORKERS });
    workers[i] = { proc, port: null, conns: 0 };
    proc.on('message', (m) => {
      if (!m) return;
      if (m.t === 'listening') workers[i].port = m.port;
      else if (m.t === 'reply' && pending.has(m.id)) { pending.get(m.id)(m.data); pending.delete(m.id); }
    });
    proc.on('exit', () => { console.error(`[cluster] worker ${i} exited — restarting`); setTimeout(() => fork(i), 1000); });
  };
  for (let i = 0; i < WORKERS; i++) fork(i);

  const ask = (i, t, data) => new Promise((res) => {
    const id = ++reqId; pending.set(id, res);
    workers[i].proc.send({ t, id, data });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res(null); } }, 2500);
  });
  const leastLoaded = () => { let b = 0; for (let i = 1; i < WORKERS; i++) if (workers[i].conns < workers[b].conns) b = i; return b; };

  // Primary-local admin HTTP server (proxied to from the gateway).
  const adminSrv = http.createServer((req, res) => adminHandler(req, res, { ADMIN_PASS, workers, ask }));
  adminSrv.listen(0, '127.0.0.1');

  const gateway = net.createServer((client) => {
    client.once('data', (chunk) => {
      client.pause();
      const url = parseUrl(chunk);
      let port;
      if (url.startsWith('/admin')) {
        port = adminSrv.address().port;
      } else {
        const code = (url.match(/[?&]room=([^&\s#]+)/i) || [])[1];
        let i = code ? workerForCode(decodeURIComponent(code), WORKERS) : -1;
        if (i < 0 || !workers[i]?.port) i = leastLoaded();
        if (process.env.CLUSTER_DEBUG) console.log(`[gw] url=${url} code=${code || '-'} -> worker ${i} port ${workers[i].port}`);
        port = workers[i].port;
        workers[i].conns++;
        client.on('close', () => { workers[i].conns--; });
      }
      proxy(client, port, chunk);
    });
    client.on('error', () => {});
  });
  waitReady(workers).then(() => gateway.listen(PORT, () => {
    console.log(`mine-sim cluster on http://localhost:${PORT}  (${WORKERS} workers)`);
    console.log(`[admin] http://localhost:${PORT}/admin  user=admin  pass=${ADMIN_PASS}`);
  }));

  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const w of workers) w.proc.kill(sig); setTimeout(() => process.exit(0), 4000).unref(); });
}

// Aggregate /admin across workers; route credit to the room's owning worker.
async function adminHandler(req, res, { ADMIN_PASS, workers, ask }) {
  if (!checkAuth(req.headers.authorization, 'admin', ADMIN_PASS)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mine-sim admin"' });
    return res.end('Authentication required');
  }
  const url = req.url || '/';
  if (url.startsWith('/admin/api/sessions')) {
    const parts = (await Promise.all(workers.map((_, i) => ask(i, 'admin-data')))).filter(Boolean);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(mergeAdmin(parts)));
  }
  if (req.method === 'POST' && url.startsWith('/admin/api/credit')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let code, amount;
      try { ({ code, amount } = JSON.parse(body || '{}')); } catch { /* bad json */ }
      const i = code ? workerForCode(String(code), workers.length) : -1;
      if (i < 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'room not found' })); }
      const r = await ask(i, 'admin-credit', { code, amount });
      const status = r && r.ok ? 200 : r && r.error === 'room not found' ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r || { error: 'timeout' }));
    });
    return undefined;
  }
  if (url === '/admin' || url.startsWith('/admin?')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return fs.createReadStream(path.join(ROOT, 'admin.html')).pipe(res);
  }
  res.writeHead(404); return res.end();
}

function mergeAdmin(parts) {
  const active = parts.flatMap((p) => p.active).sort((a, b) => b.createdAt - a.createdAt);
  const history = parts.flatMap((p) => p.history).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 200);
  const events = parts.flatMap((p) => p.events).sort((a, b) => b.at - a.at).slice(0, 200);
  return {
    now: Date.now(), graceMs: parts[0]?.graceMs || 0,
    activeCount: active.length, playerCount: active.reduce((n, s) => n + s.players, 0),
    active, history, events,
  };
}

// ── helpers ──
function parseUrl(chunk) {
  const m = chunk.toString('latin1', 0, Math.min(chunk.length, 2048)).match(/^[A-Z]+\s+(\S+)/);
  return m ? m[1] : '/';
}

// Transparent TCP proxy: write the already-read first chunk, then pipe both ways.
function proxy(client, port, firstChunk) {
  const up = net.connect(port, '127.0.0.1', () => {
    up.write(firstChunk);
    client.pipe(up);
    up.pipe(client);
    client.resume();
  });
  const kill = () => { up.destroy(); client.destroy(); };
  up.on('error', kill); client.on('error', kill);
  up.on('close', () => client.destroy()); client.on('close', () => up.destroy());
}

function waitReady(workers) {
  return new Promise((resolve) => {
    const check = () => (workers.every((w) => w && w.port) ? resolve() : setTimeout(check, 50));
    check();
  });
}

module.exports = { start };
