const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { World } = require('./game/world');

const app = express();
const PORT = process.env.PORT || 3200;

// The whole game world lives on the server and is advanced by a fixed-step tick.
// Clients connect over a single WebSocket: the server pushes `state` (full
// snapshot) and `live` (credit + vehicles + changed blocks) each tick; clients
// send commands. No HTTP polling.
const world = new World();

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

wss.on('connection', (ws) => {
  send(ws, { t: 'state', state: world.fullState() });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'drill': {
        const r = world.drill(m.x, m.y);
        send(ws, { t: 'drilled', x: m.x, y: m.y, block: r.block || null, credit: r.credit, error: r.error });
        break;
      }
      case 'roads': {
        world.setRoads(m.cells);
        // publish the canonical network to the OTHER clients so all stay in sync
        const out = JSON.stringify({ t: 'roads', cells: world.roads.serialize() });
        for (const c of wss.clients) if (c !== ws && c.readyState === c.OPEN) c.send(out);
        break;
      }
      case 'control': if (typeof m.label === 'string') world.control(m.label, { dir: m.dir, release: m.release }); break;
      case 'assign':  if (typeof m.truck === 'string') world.assign(m.truck, m.shovel || null); break;
      case 'debug':   if (typeof m.label === 'string') world.setDebug(m.label, !!m.on); break;
      case 'select':  if (typeof m.label === 'string') world.select(m.label, !!m.on); break;
      case 'reset':   world.reset(); broadcast({ t: 'state', state: world.fullState() }); break;
    }
  });
});

// ── simulation + broadcast loop ──
// Physics runs at TICK_HZ; the network publishes a DELTA every NET_EVERY ticks
// (→ NET_HZ). Delta frames carry only changed vehicles/fields and are skipped
// entirely when nothing changed, so an idle world produces almost no traffic.
const TICK_HZ = 30;
const NET_EVERY = 2;            // broadcast every 2nd tick → 15 Hz
const DT = 1 / TICK_HZ;
let tickN = 0;
let lastDebugStr = null;
setInterval(() => {
  world.tick(DT);
  if (++tickN % NET_EVERY !== 0) return;

  const live = world.liveDelta();        // also advances baselines / flushes dirty
  const debug = world.hasDebug() ? world.debugPaths() : {};
  const debugStr = JSON.stringify(debug);
  const debugChanged = debugStr !== lastDebugStr;
  lastDebugStr = debugStr;

  if (!wss.clients.size || (!live && !debugChanged)) return;
  const msg = { t: 'live', vehicles: live?.vehicles || [], blocks: live?.blocks || [] };
  if (live && 'credit' in live) msg.credit = live.credit;
  if (debugChanged || Object.keys(debug).length) msg.debug = debug;
  broadcast(msg);
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`mine-sim running on http://localhost:${PORT}`);
});
