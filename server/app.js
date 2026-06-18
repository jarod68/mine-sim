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
const { loadOrCreateAdminPass } = require('../admin');

const ROOT = path.join(__dirname, '..');

function createServer(opts = {}) {
  const config = {
    maxRooms: 500,
    graceMs: 2 * 60 * 60 * 1000,
    tickHz: 30,
    netEvery: 2,
    ...opts.config,
  };

  const adminUser = 'admin';
  const envFile = opts.envFile || path.join(opts.dataDir || process.env.DATA_DIR || ROOT, '.env');
  let adminPass = opts.adminPass;
  let adminPassSource = 'provided';
  if (!adminPass) ({ pass: adminPass, source: adminPassSource } = loadOrCreateAdminPass(envFile));

  const rooms = new RoomManager({ maxRooms: config.maxRooms, graceMs: config.graceMs });

  const app = express();
  app.use(adminRouter({ rooms, adminUser, adminPass, graceMs: config.graceMs }));
  app.use(express.static(path.join(ROOT, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  setupWebsocket(wss, { rooms });
  const loops = startLoops({ rooms, wss, tickHz: config.tickHz, netEvery: config.netEvery });

  function stop(cb) {
    loops.stop();
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => server.close(cb));
  }

  return { app, server, wss, rooms, adminUser, adminPass, adminPassSource, envFile, config, stop };
}

module.exports = { createServer };
