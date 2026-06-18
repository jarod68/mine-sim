// WebSocket connection + message routing. Lobby messages (create/join) need no
// room; everything else is scoped to the client's current room and mutates its
// authoritative World.

const { send, roomBroadcast } = require('./transport');

function setupWebsocket(wss, { rooms }) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.room = null;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => handleMessage(ws, raw, rooms));
    ws.on('close', () => rooms.removeClient(ws));
  });
}

function handleMessage(ws, raw, rooms) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;

  // ── Lobby (no room yet) ──
  if (m.t === 'create') {
    if (rooms.full()) return send(ws, { t: 'joinError', reason: 'server full' });
    const room = rooms.createRoom();
    rooms.addClient(ws, room);
    sendJoined(ws, room);
    return;
  }
  if (m.t === 'join') {
    const room = rooms.get(m.room);
    if (!room) return send(ws, { t: 'joinError', reason: 'room not found' });
    rooms.addClient(ws, room);
    sendJoined(ws, room);
    return;
  }

  // ── Room-scoped commands ──
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
      world.setRoads(m.cells);
      const out = { t: 'roads', cells: world.roads.serialize() };
      const msg = JSON.stringify(out);
      for (const c of room.clients) if (c !== ws && c.readyState === c.OPEN) c.send(msg);
      break;
    }
    case 'control': if (typeof m.label === 'string') world.control(m.label, { dir: m.dir, release: m.release }); break;
    case 'assign':  if (typeof m.truck === 'string') world.assign(m.truck, m.shovel || null); break;
    case 'debug':   if (typeof m.label === 'string') world.setDebug(m.label, !!m.on); break;
    case 'select':  if (typeof m.label === 'string') world.select(m.label, !!m.on); break;
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
      if (m.rect && typeof m.rect === 'object') {
        world.resizeParking(m.rect);
        roomBroadcast(room, { t: 'state', state: world.fullState() });
      }
      break;
  }
}

function sendJoined(ws, room) {
  send(ws, { t: 'joined', room: room.code });
  send(ws, { t: 'state', state: room.world.fullState() });
}

module.exports = { setupWebsocket, handleMessage };
