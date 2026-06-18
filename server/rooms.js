// Room lifecycle + admin bookkeeping, with no transport concerns. Each room is an
// isolated authoritative World behind a short shareable code. Connection objects
// (`ws`) are stored only as members of `room.clients`; sending is done elsewhere.

const crypto = require('crypto');
const { World } = require('../game/world');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

class RoomManager {
  constructor({ maxRooms = 500, graceMs = 2 * 60 * 60 * 1000, WorldClass = World, now = Date.now } = {}) {
    this.rooms = new Map();          // code → room
    this.maxRooms = maxRooms;
    this.graceMs = graceMs;
    this.WorldClass = WorldClass;
    this.now = now;
    this.sessionLog = [];            // ended-session summaries (bounded)
    this.eventLog = [];              // recent activity entries (bounded)
  }

  get size() { return this.rooms.size; }
  full() { return this.rooms.size >= this.maxRooms; }
  get(code) { return typeof code === 'string' ? this.rooms.get(code.toUpperCase()) : undefined; }

  logEvent(type, code, extra = {}) {
    this.eventLog.push({ at: this.now(), type, code, ...extra });
    if (this.eventLog.length > 500) this.eventLog.shift();
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
      createdAt: now, peakClients: 0, totalJoins: 0,
    };
    this.rooms.set(room.code, room);
    this.logEvent('create', room.code);
    return room;
  }

  // Attach `ws` to `room` (leaving any previous room first) and update counters.
  addClient(ws, room) {
    this.removeClient(ws);
    ws.room = room;
    room.clients.add(ws);
    room.emptySince = null;
    room.totalJoins += 1;
    room.peakClients = Math.max(room.peakClients, room.clients.size);
    this.logEvent('join', room.code, { players: room.clients.size });
  }

  removeClient(ws) {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    ws.room = null;
    if (room.clients.size === 0) room.emptySince = this.now();
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
        this.sessionLog.push({ ...summarize(room, now), status: 'ended', endedAt: now });
        if (this.sessionLog.length > 300) this.sessionLog.shift();
        this.rooms.delete(code);
        this.logEvent('reap', code);
        reaped.push(code);
      }
    }
    return reaped;
  }
}

module.exports = { RoomManager, CODE_ALPHABET };
