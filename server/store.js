// SQLite persistence (better-sqlite3). Rooms are stored as gzip-compressed JSON
// world snapshots; the admin activity log and ended-session history are mirrored
// to their own tables so they survive restarts too. All synchronous — calls are
// sub-millisecond and happen off the simulation hot path (periodic + on shutdown).

const Database = require('better-sqlite3');
const zlib = require('zlib');

class Store {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        created_at INTEGER, peak_clients INTEGER, total_joins INTEGER, empty_since INTEGER,
        snapshot BLOB, updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, type TEXT, code TEXT, players INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ended_at INTEGER, data TEXT
      );
    `);
    this._upsertRoom = this.db.prepare(`
      INSERT INTO rooms (code, created_at, peak_clients, total_joins, empty_since, snapshot, updated_at)
      VALUES (@code, @createdAt, @peakClients, @totalJoins, @emptySince, @snapshot, @updatedAt)
      ON CONFLICT(code) DO UPDATE SET
        created_at=@createdAt, peak_clients=@peakClients, total_joins=@totalJoins,
        empty_since=@emptySince, snapshot=@snapshot, updated_at=@updatedAt`);
    this._delRoom = this.db.prepare('DELETE FROM rooms WHERE code = ?');
    this._allRooms = this.db.prepare('SELECT * FROM rooms');
    this._insEvent = this.db.prepare('INSERT INTO events (at, type, code, players) VALUES (?, ?, ?, ?)');
    this._recentEvents = this.db.prepare('SELECT at, type, code, players FROM events ORDER BY id DESC LIMIT ?');
    this._trimEvents = this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?');
    this._insSession = this.db.prepare('INSERT INTO sessions (ended_at, data) VALUES (?, ?)');
    this._recentSessions = this.db.prepare('SELECT data FROM sessions ORDER BY id DESC LIMIT ?');
    this._trimSessions = this.db.prepare('DELETE FROM sessions WHERE id <= (SELECT MAX(id) FROM sessions) - ?');
  }

  // ── rooms ──
  saveRoom(meta, snapshot) {
    this._upsertRoom.run({
      code: meta.code,
      createdAt: meta.createdAt ?? null,
      peakClients: meta.peakClients ?? 0,
      totalJoins: meta.totalJoins ?? 0,
      emptySince: meta.emptySince ?? null,
      snapshot: zlib.gzipSync(JSON.stringify(snapshot)),
      updatedAt: Date.now(),
    });
  }
  deleteRoom(code) { this._delRoom.run(code); }
  loadRooms() {
    return this._allRooms.all().map((r) => ({
      code: r.code,
      createdAt: r.created_at, peakClients: r.peak_clients, totalJoins: r.total_joins,
      emptySince: r.empty_since,
      snapshot: JSON.parse(zlib.gunzipSync(r.snapshot)),
    }));
  }

  // ── admin log / history ──
  appendEvent(e) { this._insEvent.run(e.at, e.type, e.code, e.players ?? null); }
  recentEvents(n) {
    return this._recentEvents.all(n).reverse()
      .map((r) => (r.players == null ? { at: r.at, type: r.type, code: r.code }
        : { at: r.at, type: r.type, code: r.code, players: r.players }));
  }
  appendSession(s) { this._insSession.run(s.endedAt ?? Date.now(), JSON.stringify(s)); }
  recentSessions(n) { return this._recentSessions.all(n).reverse().map((r) => JSON.parse(r.data)); }

  trim(maxEvents = 5000, maxSessions = 2000) {
    try { this._trimEvents.run(maxEvents); this._trimSessions.run(maxSessions); } catch { /* ignore */ }
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}

module.exports = { Store };
