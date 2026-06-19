// Room lifecycle + admin bookkeeping, with no transport concerns. Each room is an
// isolated authoritative World behind a short shareable code. Connection objects
// (`ws`) are stored only as members of `room.clients`; sending is done elsewhere.

const crypto = require('crypto');
const { World } = require('../game/world');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

class RoomManager {
  constructor({ maxRooms = 500, graceMs = 2 * 60 * 60 * 1000, WorldClass = World, now = Date.now, store = null } = {}) {
    this.rooms = new Map();          // code → room
    this.maxRooms = maxRooms;
    this.graceMs = graceMs;
    this.WorldClass = WorldClass;
    this.now = now;
    this.store = store;              // optional SQLite Store (persistence)
    this.sessionLog = [];            // ended-session summaries (bounded)
    this.eventLog = [];              // recent activity entries (bounded)
  }

  get size() { return this.rooms.size; }
  full() { return this.rooms.size >= this.maxRooms; }
  get(code) { return typeof code === 'string' ? this.rooms.get(code.toUpperCase()) : undefined; }

  // Restore persisted rooms + admin log/history on startup (no-op without a store).
  loadFromStore() {
    if (!this.store) return;
    try {
      for (const r of this.store.loadRooms()) {
        this.rooms.set(r.code, {
          code: r.code, world: this.WorldClass.fromSnapshot(r.snapshot), clients: new Set(),
          emptySince: r.emptySince ?? this.now(), lastDebugStr: null,
          createdAt: r.createdAt, peakClients: r.peakClients, totalJoins: r.totalJoins, dirty: false,
        });
      }
      this.eventLog = this.store.recentEvents(500);
      this.sessionLog = this.store.recentSessions(300);
    } catch (e) {
      console.error('[store] load failed (starting fresh):', e.message);
    }
  }

  logEvent(type, code, extra = {}) {
    const e = { at: this.now(), type, code, ...extra };
    this.eventLog.push(e);
    if (this.eventLog.length > 500) this.eventLog.shift();
    try { this.store?.appendEvent(e); } catch { /* non-fatal */ }
  }

  // Persist rooms that changed since the last save (or that are live, to capture
  // moving vehicles). Clears the dirty flag.
  saveDirty() {
    if (!this.store) return;
    for (const room of this.rooms.values()) {
      if (!room.dirty && room.clients.size === 0) continue;
      try { this.store.saveRoom(room, room.world.toSnapshot()); room.dirty = false; } catch (e) { console.error('[store] save failed:', e.message); }
    }
    this.store.trim();
  }

  // Persist every room (used on graceful shutdown).
  saveAll() {
    if (!this.store) return;
    for (const room of this.rooms.values()) {
      try { this.store.saveRoom(room, room.world.toSnapshot()); } catch (e) { console.error('[store] save failed:', e.message); }
    }
  }

  _genCode() {
    let c;
    do {
      c = '';
      for (let i = 0; i < 5; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    } while (this.rooms.has(c));
    return c;
  }

  createRoom() {
    const now = this.now();
    const room = {
      code: this._genCode(), world: new this.WorldClass(), clients: new Set(),
      emptySince: now, lastDebugStr: null,
      createdAt: now, peakClients: 0, totalJoins: 0, dirty: true,
    };
    this.rooms.set(room.code, room);
    this.logEvent('create', room.code);
    return room;
  }

  // Mark a room's world as changed so it gets persisted on the next save.
  markDirty(room) { if (room) room.dirty = true; }

  // Attach `ws` to `room` (leaving any previous room first) and update counters.
  addClient(ws, room) {
    this.removeClient(ws);
    ws.room = room;
    room.clients.add(ws);
    room.emptySince = null;
    room.totalJoins += 1;
    room.peakClients = Math.max(room.peakClients, room.clients.size);
    room.dirty = true;
    this.logEvent('join', room.code, { players: room.clients.size });
  }

  removeClient(ws) {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    ws.room = null;
    if (room.clients.size === 0) room.emptySince = this.now();
    room.dirty = true;
    this.logEvent('leave', room.code, { players: room.clients.size });
  }

  // Drop rooms empty past the grace period, archiving a summary. Returns the
  // reaped codes. `summarize` produces the archived shape (injected to avoid a
  // cycle with admin.js).
  reapEmpty(summarize) {
    const now = this.now();
    const reaped = [];
    for (const [code, room] of this.rooms) {
      if (room.clients.size === 0 && room.emptySince && now - room.emptySince > this.graceMs) {
        const session = { ...summarize(room, now), status: 'ended', endedAt: now };
        this.sessionLog.push(session);
        if (this.sessionLog.length > 300) this.sessionLog.shift();
        this.rooms.delete(code);
        try { this.store?.deleteRoom(code); this.store?.appendSession(session); } catch { /* non-fatal */ }
        this.logEvent('reap', code);
        reaped.push(code);
      }
    }
    return reaped;
  }
}

module.exports = { RoomManager, CODE_ALPHABET };
