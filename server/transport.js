// Tiny WebSocket send helpers shared across the server modules.

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function roomBroadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

module.exports = { send, roomBroadcast };
