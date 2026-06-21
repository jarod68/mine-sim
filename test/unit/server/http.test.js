import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../../server/app.js';

const PASS = 'secret';
const AUTH = 'Basic ' + Buffer.from(`admin:${PASS}`).toString('base64');

describe('HTTP — admin routes', () => {
  let inst;
  beforeEach(() => { inst = createServer({ adminPass: PASS, dbFile: ':memory:' }); });
  afterEach(() => new Promise((r) => inst.stop(r)));

  it('requires Basic auth for the admin page and API', async () => {
    await request(inst.app).get('/admin').expect(401);
    await request(inst.app).get('/admin/api/sessions').expect(401);
    await request(inst.app).get('/admin/api/sessions').set('Authorization', 'Basic ' + Buffer.from('admin:wrong').toString('base64')).expect(401);
  });

  it('returns the session snapshot when authorised', async () => {
    inst.rooms.createRoom();
    const r = await request(inst.app).get('/admin/api/sessions').set('Authorization', AUTH).expect(200);
    expect(r.body.activeCount).toBe(1);
    expect(Array.isArray(r.body.active)).toBe(true);
    expect(Array.isArray(r.body.events)).toBe(true);
  });

  it('grants credit to a room', async () => {
    const room = inst.rooms.createRoom();
    const before = room.world.credit;
    const r = await request(inst.app).post('/admin/api/credit')
      .set('Authorization', AUTH).send({ code: room.code, amount: 100000 }).expect(200);
    expect(r.body.credit).toBe(before + 100000);
    expect(room.world.credit).toBe(before + 100000);
  });

  it('rejects credit for an unknown room or a zero amount', async () => {
    await request(inst.app).post('/admin/api/credit').set('Authorization', AUTH)
      .send({ code: 'ZZZZZ', amount: 1 }).expect(404);
    const room = inst.rooms.createRoom();
    await request(inst.app).post('/admin/api/credit').set('Authorization', AUTH)
      .send({ code: room.code, amount: 0 }).expect(400);
  });

  it('restores an ended room; rejects unknown / already-live codes', async () => {
    await request(inst.app).post('/admin/api/restore').send({ code: 'ZZZZZ' }).expect(401);   // auth required
    await request(inst.app).post('/admin/api/restore').set('Authorization', AUTH).send({ code: 'ZZZZZ' }).expect(404);

    const room = inst.rooms.createRoom();
    const code = room.code;
    room.emptySince = Date.now() - inst.config.graceMs - 1000;
    inst.rooms.reapEmpty((r) => ({ code: r.code }));                         // archived, restorable

    const s = await request(inst.app).get('/admin/api/sessions').set('Authorization', AUTH).expect(200);
    expect(s.body.history.some((h) => h.code === code && h.restorable)).toBe(true);

    const r = await request(inst.app).post('/admin/api/restore').set('Authorization', AUTH).send({ code }).expect(200);
    expect(r.body.ok).toBe(true);
    expect(inst.rooms.get(code)).toBeTruthy();
    await request(inst.app).post('/admin/api/restore').set('Authorization', AUTH).send({ code }).expect(409); // already active
  });

  it('serves the static client at /', async () => {
    const r = await request(inst.app).get('/').expect(200);
    expect(r.text).toContain('Mine Sim');
  });
});
