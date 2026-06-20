// Background timers: the per-room simulation + broadcast loop, the WebSocket
// heartbeat (keeps connections alive through proxy idle timeouts), and the
// empty-room reaper. `startLoops` returns a `stop()` so tests can tear down.

const { roomBroadcast } = require('./transport');
const { sessionSummary } = require('../admin');

function startLoops({ rooms, wss, tickHz = 30, netEvery = 2, heartbeatMs = 30000, reapMs = 60000, persistMs = 15000,
  idleEvery = 6, idleActiveMs = 1500, log = console }) {
  const dt = 1 / tickHz;
  let tickN = 0;

  const tick = setInterval(() => {
    try {
      const doNet = (++tickN % netEvery === 0);
      const now = Date.now();
      for (const room of rooms.rooms.values()) {
        if (room.clients.size === 0) continue;     // frozen while nobody is connected

        // Adaptive tick: a room where nothing is moving and no command arrived
        // recently is "idle" — tick it only every `idleEvery`-th frame (with the
        // matching larger dt) to free the CPU for busy rooms. Any motion or
        // command instantly returns it to full rate.
        const active = room.world.anyMoving() || (now - (room.lastActivity || 0) < idleActiveMs);
        if (active) { room._skip = 0; } else if (((room._skip = (room._skip || 0) + 1) % idleEvery) !== 0) { continue; }
        room.world.tick(active ? dt : dt * idleEvery);
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
      log.error('[tick] error (continuing):', err);
    }
  }, 1000 / tickHz);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        log.warn(`[hb] terminating unresponsive ws (room=${ws.room?.code ?? '-'})`);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, heartbeatMs);

  const reaper = setInterval(() => {
    for (const code of rooms.reapEmpty(sessionSummary)) log.log(`[reap] room=${code} (empty > grace)`);
  }, reapMs);

  // Write-behind persistence: snapshot changed/live rooms to the store.
  const persist = setInterval(() => {
    try { rooms.saveDirty(); } catch (err) { log.error('[persist] error:', err); }
  }, persistMs);

  return {
    stop() { clearInterval(tick); clearInterval(heartbeat); clearInterval(reaper); clearInterval(persist); },
  };
}

module.exports = { startLoops };
