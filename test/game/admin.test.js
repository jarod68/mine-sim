import { describe, it, expect } from 'vitest';
import { genPassword, safeEqual, checkAuth, sessionSummary, buildAdminData } from '../../admin.js';

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
