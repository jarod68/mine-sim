import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/app.js';

describe('persistence (SQLite)', () => {
  const tmp = [];
  const dbFile = () => { const p = path.join(os.tmpdir(), `minesim-${Math.random().toString(36).slice(2)}.db`); tmp.push(p); return p; };
  afterEach(() => {
    for (const p of tmp.splice(0)) for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + s); } catch { /* gone */ } }
  });
  const stop = (inst) => new Promise((r) => inst.stop(r));

  it('restores rooms + world state + the activity log after a restart', async () => {
    const file = dbFile();

    let inst = createServer({ adminPass: 'x', dbFile: file });
    const code = inst.rooms.createRoom().code;
    const w = inst.rooms.get(code).world;
    w.credit = 2000000;
    w.drill(50, 40);
    w.buyAsset('PR776');
    const expectedCredit = w.credit;
    const expectedVehicles = w.vehicles.length;
    await stop(inst);                                  // stop() persists everything

    inst = createServer({ adminPass: 'x', dbFile: file });   // "redeploy"
    const r2 = inst.rooms.get(code);
    expect(r2).toBeTruthy();
    expect(r2.world.credit).toBe(expectedCredit);
    expect(r2.world.vehicles.length).toBe(expectedVehicles);
    expect(r2.world.vehicles.some((v) => v.type === 'dozer')).toBe(true);
    expect(r2.world.mine.blocks[40][50].explored).toBe(true);          // drilled block kept
    expect(inst.rooms.eventLog.some((e) => e.type === 'create' && e.code === code)).toBe(true);
    // the restored world keeps simulating
    expect(() => { for (let i = 0; i < 60; i++) r2.world.tick(1 / 30); }).not.toThrow();
    await stop(inst);
  });

  it('forgets a room once it has been reaped', async () => {
    const file = dbFile();
    let inst = createServer({ adminPass: 'x', dbFile: file });
    const room = inst.rooms.createRoom();
    const code = room.code;
    room.emptySince = Date.now() - inst.config.graceMs - 1000;       // make it overdue
    inst.rooms.reapEmpty((r) => ({ code: r.code }));                  // deletes from the store
    await stop(inst);

    inst = createServer({ adminPass: 'x', dbFile: file });
    expect(inst.rooms.get(code)).toBeUndefined();
    await stop(inst);
  });
});
