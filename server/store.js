// SQLite persistence (better-sqlite3). Rooms are stored as gzip-compressed JSON
// world snapshots; the admin activity log and ended-session history are mirrored
// to their own tables so they survive restarts too. All synchronous — calls are
// sub-millisecond and happen off the simulation hot path (periodic + on shutdown).

const Database = require('better-sqlite3');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);

class Store {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        created_at INTEGER, peak_clients INTEGER, total_joins INTEGER, empty_since INTEGER,
        snapshot BLOB, updated_at INTEGER, ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, type TEXT, code TEXT, players INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ended_at INTEGER, data TEXT
      );
      CREATE TABLE IF NOT EXISTS metrics (
        at INTEGER, rooms INTEGER, players INTEGER, created INTEGER
      );
      CREATE INDEX IF NOT EXISTS metrics_at ON metrics (at);
    `);
    // Migrate older DBs that predate the `ended_at` column (ended rooms kept for
    // admin restore instead of being deleted).
    try { this.db.exec('ALTER TABLE rooms ADD COLUMN ended_at INTEGER'); } catch { /* already present */ }

    this._upsertRoom = this.db.prepare(`
      INSERT INTO rooms (code, created_at, peak_clients, total_joins, empty_since, snapshot, updated_at)
      VALUES (@code, @createdAt, @peakClients, @totalJoins, @emptySince, @snapshot, @updatedAt)
      ON CONFLICT(code) DO UPDATE SET
        created_at=@createdAt, peak_clients=@peakClients, total_joins=@totalJoins,
        empty_since=@emptySince, snapshot=@snapshot, updated_at=@updatedAt`);
    // Archive a room (reaped): save its final snapshot AND stamp ended_at so it
    // drops out of the active set but stays restorable.
    this._archiveRoom = this.db.prepare(`
      INSERT INTO rooms (code, created_at, peak_clients, total_joins, empty_since, snapshot, updated_at, ended_at)
      VALUES (@code, @createdAt, @peakClients, @totalJoins, @emptySince, @snapshot, @updatedAt, @endedAt)
      ON CONFLICT(code) DO UPDATE SET
        created_at=@createdAt, peak_clients=@peakClients, total_joins=@totalJoins,
        empty_since=@emptySince, snapshot=@snapshot, updated_at=@updatedAt, ended_at=@endedAt`);
    this._markActive = this.db.prepare('UPDATE rooms SET ended_at = NULL WHERE code = ?');
    this._oneRoom = this.db.prepare('SELECT * FROM rooms WHERE code = ?');
    this._endedCodes = this.db.prepare('SELECT code FROM rooms WHERE ended_at IS NOT NULL');
    this._trimEnded = this.db.prepare(
      'DELETE FROM rooms WHERE ended_at IS NOT NULL AND code NOT IN (SELECT code FROM rooms WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?)');
    this._delRoom = this.db.prepare('DELETE FROM rooms WHERE code = ?');
    this._activeRooms = this.db.prepare('SELECT * FROM rooms WHERE ended_at IS NULL');
    this._insEvent = this.db.prepare('INSERT INTO events (at, type, code, players) VALUES (?, ?, ?, ?)');
    this._recentEvents = this.db.prepare('SELECT at, type, code, players FROM events ORDER BY id DESC LIMIT ?');
    this._trimEvents = this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?');
    this._insSession = this.db.prepare('INSERT INTO sessions (ended_at, data) VALUES (?, ?)');
    this._recentSessions = this.db.prepare('SELECT data FROM sessions ORDER BY id DESC LIMIT ?');
    this._trimSessions = this.db.prepare('DELETE FROM sessions WHERE id <= (SELECT MAX(id) FROM sessions) - ?');
    this._insMetric = this.db.prepare('INSERT INTO metrics (at, rooms, players, created) VALUES (?, ?, ?, ?)');
    this._metricsSince = this.db.prepare('SELECT at, rooms, players, created FROM metrics WHERE at >= ? ORDER BY at');
    this._trimMetrics = this.db.prepare('DELETE FROM metrics WHERE at < ?');
  }

  // ── rooms ──
  // `json` is a pre-serialised snapshot string (World.snapshotJson). gzip runs
  // off the main thread (async) so persisting many rooms never stalls the tick;
  // only the fast SQLite write is synchronous.
  async saveRoom(meta, json) {
    const blob = await gzip(typeof json === 'string' ? json : JSON.stringify(json));
    this._upsertRoom.run({
      code: meta.code,
      createdAt: meta.createdAt ?? null,
      peakClients: meta.peakClients ?? 0,
      totalJoins: meta.totalJoins ?? 0,
      emptySince: meta.emptySince ?? null,
      snapshot: blob,
      updatedAt: Date.now(),
    });
  }
  deleteRoom(code) { this._delRoom.run(code); }

  // Archive a reaped room (synchronous gzip — reap is infrequent): persist its
  // final snapshot and stamp ended_at so it leaves the active set but stays
  // restorable from the admin page.
  archiveRoom(meta, json, endedAt) {
    const blob = zlib.gzipSync(typeof json === 'string' ? json : JSON.stringify(json));
    this._archiveRoom.run({
      code: meta.code,
      createdAt: meta.createdAt ?? null,
      peakClients: meta.peakClients ?? 0,
      totalJoins: meta.totalJoins ?? 0,
      emptySince: meta.emptySince ?? null,
      snapshot: blob,
      updatedAt: Date.now(),
      endedAt: endedAt ?? Date.now(),
    });
  }
  markRoomActive(code) { this._markActive.run(code); }
  endedRoomCodes() { return this._endedCodes.all().map((r) => r.code); }

  _hydrate(r) {
    return {
      code: r.code,
      createdAt: r.created_at, peakClients: r.peak_clients, totalJoins: r.total_joins,
      emptySince: r.empty_since,
      snapshot: JSON.parse(zlib.gunzipSync(r.snapshot)),
    };
  }
  // Load ONE room by code, ended or not (for restore). Null if absent / no snapshot.
  loadRoom(code) {
    const r = this._oneRoom.get(code);
    return r && r.snapshot ? this._hydrate(r) : null;
  }
  // Active rooms only (ended ones are kept for restore but not auto-loaded).
  loadRooms() { return this._activeRooms.all().map((r) => this._hydrate(r)); }

  // ── admin log / history ──
  appendEvent(e) { this._insEvent.run(e.at, e.type, e.code, e.players ?? null); }
  recentEvents(n) {
    return this._recentEvents.all(n).reverse()
      .map((r) => (r.players == null ? { at: r.at, type: r.type, code: r.code }
        : { at: r.at, type: r.type, code: r.code, players: r.players }));
  }
  appendSession(s) { this._insSession.run(s.endedAt ?? Date.now(), JSON.stringify(s)); }
  recentSessions(n) { return this._recentSessions.all(n).reverse().map((r) => JSON.parse(r.data)); }

  // ── metrics (periodic samples for the admin charts) ──
  appendMetric(at, rooms, players, created) { this._insMetric.run(at, rooms, players, created); }
  metricsSince(since) { return this._metricsSince.all(since); }

  trim(maxEvents = 5000, maxSessions = 2000, maxEnded = 200, metricsMaxAgeMs = 8 * 24 * 3600 * 1000) {
    try {
      this._trimEvents.run(maxEvents);
      this._trimSessions.run(maxSessions);
      this._trimEnded.run(maxEnded);          // bound the kept (restorable) ended rooms
      this._trimMetrics.run(Date.now() - metricsMaxAgeMs);
    } catch { /* ignore */ }
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
}

module.exports = { Store };
