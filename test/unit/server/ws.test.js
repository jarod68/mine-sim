import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createServer } from '../../../server/app.js';

// Collect inbound messages and await one of a given type.
function collect(ws) {
  const msgs = [];
  ws.on('message', (raw, isBinary) => { if (!isBinary) msgs.push(JSON.parse(raw)); });   // skip binary `pos` frames
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
    inst = createServer({ adminPass: 'x', dbFile: ':memory:' });
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
    // (10,10) sits in the spawn keep-out, so it's never a (un-drillable) prep vein.
    ws.send(JSON.stringify({ t: 'drill', x: 10, y: 10 }));
    const d = await c.wait('drilled');
    expect(d.x).toBe(10);
    expect(d.block && d.block.explored).toBe(true);
    ws.close();
  });

  it('sanitizes a hostile roads payload (drops out-of-bounds cells)', async () => {
    const ws = open();
    const c = collect(ws);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'create' })));
    const joined = await c.wait('joined');
    // (20,20) → block (10,10), inside the spawn keep-out, so it's never an
    // un-prepared vein cell (which setRoads would also legitimately drop).
    ws.send(JSON.stringify({ t: 'roads', cells: [{ gx: 9e8, gy: 9e8 }, { gx: 20, gy: 20, dir: { dx: 1, dy: 0 } }] }));
    await new Promise((r) => setTimeout(r, 80));
    const room = inst.rooms.get(joined.room);
    expect(room.world.roads.serialize().some((cc) => cc.gx === 9e8)).toBe(false);
    expect(room.world.roads.serialize().some((cc) => cc.gx === 20 && cc.gy === 20)).toBe(true);
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

  it('TEST_MODE lifts the per-IP connection cap (24)', async () => {
    const N = 28;   // > MAX_CONN_PER_IP
    const openCount = async (testMode) => {
      const i2 = createServer({ adminPass: 'x', dbFile: ':memory:', testMode });
      await new Promise((r) => i2.server.listen(0, r));
      const p = i2.server.address().port;
      const conns = Array.from({ length: N }, () => new WebSocket(`ws://localhost:${p}`));
      conns.forEach((w) => w.on('error', () => {}));
      await new Promise((r) => setTimeout(r, 1500));
      const open = conns.filter((w) => w.readyState === WebSocket.OPEN).length;
      conns.forEach((w) => { try { w.terminate(); } catch { /* ignore */ } });
      await new Promise((r) => i2.stop(r));
      return open;
    };
    expect(await openCount(false)).toBeLessThanOrEqual(24);   // capped
    expect(await openCount(true)).toBe(N);                    // uncapped
  });
});
