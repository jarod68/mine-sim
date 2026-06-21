import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { genPassword, loadOrCreateAdminPass, readEnvVar, safeEqual, checkAuth, sessionSummary, buildAdminData, buildMetrics } from '../../../admin.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

// A minimal room double: just what sessionSummary reads.
const fakeRoom = (over = {}) => ({
  code: 'ABCDE',
  createdAt: 1000,
  peakClients: 2,
  totalJoins: 3,
  emptySince: null,
  clients: new Set([1]),
  world: { credit: 75000, vehicles: [{ type: 'oht', load: 120 }, { type: 'oht', load: 0 }, { type: 'excavator' }] },
  ...over,
});

describe('admin — auth', () => {
  it('generates a non-empty url-safe password', () => {
    const p = genPassword();
    expect(p.length).toBeGreaterThanOrEqual(10);
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts the right credentials and rejects everything else', () => {
    expect(checkAuth(basic('admin', 'secret'), 'admin', 'secret')).toBe(true);
    expect(checkAuth(basic('admin', 'wrong'), 'admin', 'secret')).toBe(false);
    expect(checkAuth(basic('root', 'secret'), 'admin', 'secret')).toBe(false);
    expect(checkAuth('Bearer x', 'admin', 'secret')).toBe(false);
    expect(checkAuth(undefined, 'admin', 'secret')).toBe(false);
    expect(checkAuth('Basic not-base64!!', 'admin', 'secret')).toBe(false);
  });

  it('safeEqual is length-safe', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });
});

describe('admin — password persistence', () => {
  const tmp = [];
  const tmpEnv = () => { const p = path.join(os.tmpdir(), `minesim-${Math.random().toString(36).slice(2)}.env`); tmp.push(p); return p; };
  afterEach(() => { for (const p of tmp.splice(0)) { try { fs.unlinkSync(p); } catch { /* gone */ } } delete process.env.ADMIN_PASS; });

  it('generates and persists a password to the .env on first init', () => {
    const file = tmpEnv();
    const a = loadOrCreateAdminPass(file);
    expect(a.source).toBe('generated');
    expect(a.pass.length).toBeGreaterThanOrEqual(10);
    expect(readEnvVar(file, 'ADMIN_PASS')).toBe(a.pass);
  });

  it('reuses the persisted password on the next init (survives a redeploy)', () => {
    const file = tmpEnv();
    const first = loadOrCreateAdminPass(file).pass;
    const second = loadOrCreateAdminPass(file);
    expect(second.source).toBe('file');
    expect(second.pass).toBe(first);
  });

  it('lets an explicit ADMIN_PASS env var override the file', () => {
    const file = tmpEnv();
    loadOrCreateAdminPass(file);            // seed a file value
    process.env.ADMIN_PASS = 'override-me';
    const r = loadOrCreateAdminPass(file);
    expect(r.source).toBe('env');
    expect(r.pass).toBe('override-me');
  });

  it('appends without clobbering existing .env contents', () => {
    const file = tmpEnv();
    fs.writeFileSync(file, 'FOO=bar\n');
    loadOrCreateAdminPass(file);
    expect(readEnvVar(file, 'FOO')).toBe('bar');
    expect(readEnvVar(file, 'ADMIN_PASS')).toBeTruthy();
  });
});

describe('admin — session snapshot', () => {
  it('summarizes a room: players, credit, asset counts', () => {
    const s = sessionSummary(fakeRoom(), 4000);
    expect(s.code).toBe('ABCDE');
    expect(s.players).toBe(1);
    expect(s.peakPlayers).toBe(2);
    expect(s.ageMs).toBe(3000);
    expect(s.credit).toBe(75000);
    expect(s.assets).toEqual({ oht: 2, excavator: 1 });
    expect(s.carrying).toBe(120);
    expect(s.vehicleCount).toBe(3);
  });

  it('builds the admin payload with active/idle status, history and events', () => {
    const rooms = new Map([
      ['ABCDE', fakeRoom({ code: 'ABCDE', createdAt: 2000 })],
      ['FGHIJ', fakeRoom({ code: 'FGHIJ', createdAt: 3000, clients: new Set() })], // idle
    ]);
    const d = buildAdminData({
      rooms,
      sessionLog: [{ code: 'OLD01', status: 'ended' }],
      eventLog: [{ at: 1, type: 'create', code: 'ABCDE' }],
      graceMs: 5000,
      now: 9000,
    });
    expect(d.activeCount).toBe(2);
    expect(d.playerCount).toBe(1);                 // only ABCDE has a connected client
    expect(d.active[0].code).toBe('FGHIJ');        // newest first
    expect(d.active[1].status).toBe('active');
    expect(d.active[0].status).toBe('idle');
    expect(d.history[0].code).toBe('OLD01');
    expect(d.events[0].type).toBe('create');
  });
});

describe('admin — metrics buckets', () => {
  const H = 3600000, D = 86400000;
  const now = 1_700_000_000_000;   // fixed reference

  it('buckets into 24 hourly + 7 daily clock-aligned slots, peak/sum aggregated', () => {
    const rows = [
      { at: now, rooms: 3, players: 5, created: 1 },
      { at: now - 2 * H, rooms: 2, players: 8, created: 2 },
      { at: now - 2 * H + 60000, rooms: 4, players: 3, created: 1 },   // same hour as above
      { at: now - 5 * D, rooms: 1, players: 2, created: 4 },
      { at: now - 30 * D, rooms: 9, players: 9, created: 9 },          // older than a week → dropped
    ];
    const m = buildMetrics(rows, now);
    expect(m.day).toHaveLength(24);
    expect(m.week).toHaveLength(7);

    const last = m.day[m.day.length - 1];
    expect(last.created).toBe(1);
    expect(last.players).toBe(5);

    const twoAgo = m.day[m.day.length - 3];
    expect(twoAgo.created).toBe(3);          // 2 + 1 summed
    expect(twoAgo.players).toBe(8);          // peak
    expect(twoAgo.rooms).toBe(4);

    expect(m.week.some((b) => b.created === 4)).toBe(true);   // 5-day-old sample
    expect(m.week.every((b) => b.created !== 9)).toBe(true);  // 30-day-old excluded
  });

  it('handles no rows', () => {
    const m = buildMetrics([], now);
    expect(m.day.every((b) => b.created === 0 && b.players === 0)).toBe(true);
  });
});
