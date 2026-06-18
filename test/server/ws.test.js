import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer } from '../../server/app.js';

// Collect inbound messages and await one of a given type.
function collect(ws) {
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
  return {
    msgs,
    wait: (type, timeout = 3000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = msgs.find((x) => x.t === type);
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`timeout waiting ${type}`)); }
      }, 5);
    }),
  };
}

describe('WS — integration', () => {
  let inst, port;
  beforeEach(async () => {
    inst = createServer({ adminPass: 'x' });
    await new Promise((r) => inst.server.listen(0, r));
    port = inst.server.address().port;
  });
  afterEach(() => new Promise((r) => inst.stop(r)));

  const open = (opts) => {
    const ws = new WebSocket(`ws://localhost:${port}`, { origin: `http://localhost:${port}`, ...opts });
    return ws;
  };

  it('creates a room and pushes the initial state', async () => {
    const ws = open();
    const c = collect(ws);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'create' })));
    const joined = await c.wait('joined');
    expect(joined.room).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    const state = await c.wait('state');
    expect(state.state.vehicles.length).toBeGreaterThan(0);
    expect(state.state.parking).toBeTruthy();
    ws.close();
  });

  it('reports joinError for an unknown room code', async () => {
    const ws = open();
    const c = collect(ws);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: 'ZZZZZ' })));
    const err = await c.wait('joinError');
    expect(err.reason).toBe('room not found');
    ws.close();
  });

  it('drills a block on command', async () => {
    const ws = open();
    const c = collect(ws);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'create' })));
    await c.wait('joined');
    ws.send(JSON.stringify({ t: 'drill', x: 50, y: 50 }));
    const d = await c.wait('drilled');
    expect(d.x).toBe(50);
    expect(d.block && d.block.explored).toBe(true);
    ws.close();
  });

  it('sanitizes a hostile roads payload (drops out-of-bounds cells)', async () => {
    const ws = open();
    const c = collect(ws);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'create' })));
    const joined = await c.wait('joined');
    ws.send(JSON.stringify({ t: 'roads', cells: [{ gx: 9e8, gy: 9e8 }, { gx: 60, gy: 60, dir: { dx: 1, dy: 0 } }] }));
    await new Promise((r) => setTimeout(r, 80));
    const room = inst.rooms.get(joined.room);
    expect(room.world.roads.serialize().some((cc) => cc.gx === 9e8)).toBe(false);
    expect(room.world.roads.serialize().some((cc) => cc.gx === 60 && cc.gy === 60)).toBe(true);
    ws.close();
  });

  it('rejects a cross-site (foreign Origin) WebSocket upgrade', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`, { origin: 'https://evil.test' });
    const rejected = await new Promise((res) => {
      ws.on('error', () => res(true));
      ws.on('open', () => res(false));
    });
    expect(rejected).toBe(true);
  });
});
