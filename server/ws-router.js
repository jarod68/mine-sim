// WebSocket connection + message routing. Lobby messages (create/join) need no
// room; everything else is scoped to the client's current room and mutates its
// authoritative World.

const { send, roomBroadcast } = require('./transport');
const { validateLobby, validateCommand } = require('./validators');

function setupWebsocket(wss, { rooms }) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.room = null;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => handleMessage(ws, raw, rooms));
    ws.on('close', () => rooms.removeClient(ws));
  });
}

// Sub-zone + block grid bounds for validating a room's commands.
function worldBounds(world) {
  return {
    cols: world.mine.cols, rows: world.mine.rows,
    zoneCols: world.grid.zoneCols, zoneRows: world.grid.zoneRows,
  };
}

function handleMessage(ws, raw, rooms) {
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
      return sendJoined(ws, room);
    }
    const room = rooms.get(m.room);
    if (!room) return send(ws, { t: 'joinError', reason: 'room not found' });
    rooms.addClient(ws, room);
    return sendJoined(ws, room);
  }

  // ── Room-scoped commands ──
  const room = ws.room;
  if (!room) return;
  const world = room.world;
  const m = validateCommand(parsed, worldBounds(world));
  if (!m) return;
  switch (m.t) {
    case 'drill': {
      const r = world.drill(m.x, m.y);
      send(ws, { t: 'drilled', x: m.x, y: m.y, block: r.block || null, credit: r.credit, error: r.error });
      break;
    }
    case 'roads': {
      world.setRoads(m.cells);
      const out = { t: 'roads', cells: world.roads.serialize() };
      const msg = JSON.stringify(out);
      for (const c of room.clients) if (c !== ws && c.readyState === c.OPEN) c.send(msg);
      break;
    }
    case 'control': world.control(m.label, { dir: m.dir, release: m.release }); break;
    case 'assign':  world.assign(m.truck, m.shovel); break;
    case 'debug':   world.setDebug(m.label, m.on); break;
    case 'select':  world.select(m.label, m.on); break;
    case 'buy': {
      const r = world.buyAsset(m.id);
      send(ws, { t: 'bought', id: m.id, ok: r.ok, error: r.error, credit: r.credit, label: r.label });
      if (r.ok) roomBroadcast(room, { t: 'vehicle', vehicle: r.vehicle });
      break;
    }
    case 'reset':
      world.reset();
      roomBroadcast(room, { t: 'state', state: world.fullState() });
      rooms.logEvent('reset', room.code);
      break;
    case 'resizeParking':
      world.resizeParking(m.rect);
      roomBroadcast(room, { t: 'state', state: world.fullState() });
      break;
  }
}

function sendJoined(ws, room) {
  send(ws, { t: 'joined', room: room.code });
  send(ws, { t: 'state', state: room.world.fullState() });
}

module.exports = { setupWebsocket, handleMessage };
