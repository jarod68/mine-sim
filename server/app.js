// Composition root: wires the room manager, admin routes, static client, the
// WebSocket router and the background loops into one server. Returns handles
// (incl. `stop()`) so it can be started by server.js or driven by tests on an
// ephemeral port.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./rooms');
const { adminRouter } = require('./admin-routes');
const { setupWebsocket } = require('./ws-router');
const { startLoops } = require('./loop');
const { RateLimiter } = require('./rate-limit');
const { parseOrigins, verifyOrigin } = require('./security');
const { Store } = require('./store');
const { loadOrCreateAdminPass } = require('../admin');

const ROOT = path.join(__dirname, '..');

function createServer(opts = {}) {
  const config = {
    maxRooms: 500,
    graceMs: 2 * 60 * 60 * 1000,
    tickHz: 30,
    netEvery: 2,
    maxPayload: 1024 * 1024,                 // 1 MB inbound frame cap (≫ a full roads edit)
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
    rate: { ratePerSec: 30, burst: 60 },
    ...opts.config,
  };

  const adminUser = 'admin';
  const dataDir = opts.dataDir || process.env.DATA_DIR || ROOT;
  const envFile = opts.envFile || path.join(dataDir, '.env');
  let adminPass = opts.adminPass;
  let adminPassSource = 'provided';
  if (!adminPass) ({ pass: adminPass, source: adminPassSource } = loadOrCreateAdminPass(envFile));

  // SQLite persistence. `dbFile` may be ':memory:' (tests) or null to disable.
  const dbFile = opts.dbFile !== undefined ? opts.dbFile : path.join(dataDir, 'minesim.db');
  let store = null;
  if (dbFile) {
    try { store = new Store(dbFile); } catch (e) { console.error('[store] disabled (open failed):', e.message); }
  }
  const rooms = new RoomManager({ maxRooms: config.maxRooms, graceMs: config.graceMs, store });
  rooms.loadFromStore();

  const app = express();
  app.use(adminRouter({ rooms, adminUser, adminPass, graceMs: config.graceMs }));
  app.use(express.static(path.join(ROOT, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    maxPayload: config.maxPayload,
    verifyClient: (info) => verifyOrigin(info, config.allowedOrigins),
  });
  setupWebsocket(wss, { rooms, limiter: new RateLimiter(config.rate) });
  const loops = startLoops({ rooms, wss, tickHz: config.tickHz, netEvery: config.netEvery });

  function stop(cb) {
    loops.stop();
    try { rooms.saveAll(); } catch (e) { console.error('[store] final save failed:', e.message); }
    if (store) store.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => {
      if (server.listening) server.close(cb); else if (cb) cb();
    });
  }

  return { app, server, wss, rooms, store, adminUser, adminPass, adminPassSource, envFile, dbFile, config, stop };
}

module.exports = { createServer };
