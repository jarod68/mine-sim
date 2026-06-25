// WebSocket connection + message routing. Lobby messages (create/join) need no
// room; everything else is scoped to the client's current room and mutates its
// authoritative World.

const { send, roomBroadcast } = require('./transport');
const { validateLobby, validateCommand } = require('./validators');
const { RateLimiter } = require('./rate-limit');
const { clientIp } = require('./security');

const MAX_CONN_PER_IP = 24;     // cap simultaneous sockets from one address
const MAX_DROPPED = 400;        // terminate a socket that keeps flooding
const MAX_JOIN_FAILS = 20;      // terminate a socket brute-forcing room codes

// Per-action minimum interval (ms) on top of the global rate limiter, for
// commands that are expensive and/or broadcast to the whole room — so one
// client can't rebuild + rebroadcast a world 30×/s. 0 / absent = no extra gate.
const ACTION_COOLDOWN = {
  reset: 3000,           // rebuilds the world and broadcasts full state
  buyCrusher: 250,       // room-wide broadcast (also credit-gated)
  resizeParking: 120,    // reserializes + broadcasts the whole road network
};

// True (and stamps the clock) when `action` is allowed now; false while it is
// still cooling down. State lives on the socket so it's reclaimed on close.
function actionCooled(ws, action, now = Date.now()) {
  const gap = ACTION_COOLDOWN[action];
  if (!gap) return true;
  const cd = ws._cd || (ws._cd = {});
  const last = cd[action];
  if (last !== undefined && now - last < gap) return false;   // first call always passes
  cd[action] = now;
  return true;
}

// `testMode` lifts every per-IP / per-connection anti-abuse limit (connection
// cap, rate limiter, join-fail terminate) so a load test can hammer the server
// from a single IP. Off by default; enable only for benchmarking.
function setupWebsocket(wss, { rooms, limiter = new RateLimiter(), testMode = false }) {
  const perIp = new Map();      // ip → live socket count

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const n = (perIp.get(ip) || 0) + 1;
    perIp.set(ip, n);
    if (!testMode && n > MAX_CONN_PER_IP) { perIp.set(ip, n - 1); return ws.close(1013, 'too many connections'); }

    ws.isAlive = true;
    ws.room = null;
    ws._drops = 0;
    ws._joinFails = 0;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      if (!testMode && !limiter.allow(ws)) {           // flood control
        if (++ws._drops > MAX_DROPPED) ws.terminate();
        return;
      }
      handleMessage(ws, raw, rooms, testMode);
    });
    ws.on('close', () => {
      rooms.removeClient(ws);
      const left = (perIp.get(ip) || 1) - 1;
      if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
    });
  });
}

// Sub-zone + block grid bounds for validating a room's commands.
function worldBounds(world) {
  return {
    cols: world.mine.cols, rows: world.mine.rows,
    zoneCols: world.grid.zoneCols, zoneRows: world.grid.zoneRows,
  };
}

function handleMessage(ws, raw, rooms, testMode = false) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed || typeof parsed.t !== 'string') return;

  // ── Lobby (no room yet) ──
  if (parsed.t === 'create' || parsed.t === 'join') {
    const m = validateLobby(parsed);
    if (!m) return;
    if (m.t === 'create') {
      if (rooms.full()) return send(ws, { t: 'joinError', reason: 'server full' });
      const room = rooms.createRoom();
      rooms.addClient(ws, room);
      return sendJoined(ws, room, testMode);
    }
    const room = rooms.get(m.room);
    if (!room) {
      send(ws, { t: 'joinError', reason: 'room not found' });
      if (!testMode && ++ws._joinFails > MAX_JOIN_FAILS) ws.terminate();   // code-enumeration guard
      return;
    }
    rooms.addClient(ws, room);
    return sendJoined(ws, room, testMode);
  }

  // ── Room-scoped commands ──
  const room = ws.room;
  if (!room) return;
  const world = room.world;
  const m = validateCommand(parsed, worldBounds(world));
  if (!m) return;
  if (!testMode && !actionCooled(ws, m.t)) return;   // per-action anti-spam
  switch (m.t) {
    case 'drill': {
      const r = world.drill(m.x, m.y);
      send(ws, { t: 'drilled', x: m.x, y: m.y, block: r.block || null, credit: r.credit, error: r.error });
      break;
    }
    case 'roads': {
      const r = world.setRoads(m.cells);
      const out = { t: 'roads', cells: world.roads.serialize() };
      const msg = JSON.stringify(out);
      for (const c of room.clients) if (c !== ws && c.readyState === c.OPEN) c.send(msg);
      // Budget hit → some cells were dropped; echo the canonical network back to
      // the drawer so its optimistic stroke is corrected. (Credit propagates via
      // the next live broadcast.)
      if (r.dropped) send(ws, out);
      break;
    }
    case 'control': world.control(m.label, { dir: m.dir, release: m.release }); break;
    case 'moveTo':  world.moveTo(m.label, m.gx, m.gy); break;
    case 'assign':  world.assign(m.truck, m.shovel); break;
    case 'debug':   world.setDebug(m.label, m.on); break;
    case 'select':  world.select(m.label, m.on); break;
    case 'buy': {
      const r = world.buyAsset(m.id);
      send(ws, { t: 'bought', id: m.id, ok: r.ok, error: r.error, credit: r.credit, label: r.label });
      if (r.ok) roomBroadcast(room, { t: 'vehicle', vehicle: r.vehicle });
      break;
    }
    case 'buyCrusher': {
      const r = world.buyCrusher(m.gx, m.gy);
      send(ws, { t: 'crusherBought', ok: r.ok, error: r.error, credit: r.credit, extraCrushers: r.extraCrushers });
      if (r.ok) roomBroadcast(room, { t: 'crusher', crusher: r.crusher, extraCrushers: r.extraCrushers });
      break;
    }
    case 'reset':
      world.reset();
      roomBroadcast(room, { t: 'state', state: world.fullState() });
      rooms.logEvent('reset', room.code);
      break;
    case 'breakdown':
      if (testMode) world.testBreakdown();   // force a random asset to break (test only)
      break;
    case 'resizeParking': {
      const rect = world.resizeParking(m.rect);
      // Only the pad + road network changed — no need to resend the whole grid.
      roomBroadcast(room, { t: 'parking', rect, cells: world.roads.serialize() });
      break;
    }
  }
  rooms.markDirty(room);   // any command mutated the world → persist on next save
}

function sendJoined(ws, room, testMode = false) {
  send(ws, { t: 'joined', room: room.code });
  const state = room.world.fullState();
  state.testMode = testMode;          // lets the client enable the 'P' test-breakdown key
  send(ws, { t: 'state', state });
}

module.exports = { setupWebsocket, handleMessage, actionCooled, ACTION_COOLDOWN };
