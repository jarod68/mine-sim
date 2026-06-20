// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket } from './_helpers.js';

let FakeWebSocket;
let Net;

beforeEach(async () => {
  FakeWebSocket = installFakeWebSocket();
  // import after the global is stubbed (Net connects in its constructor)
  ({ Net } = await import('../../../public/components/net.js'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function connectedNet() {
  const net = new Net();
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  return { net, ws };
}

describe('Net — sending', () => {
  it('buffers commands until the socket opens, then flushes them', () => {
    const net = new Net();
    const ws = FakeWebSocket.instances.at(-1);
    net.drill(1, 2);                 // socket still CONNECTING
    expect(ws.sent.length).toBe(0);
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ t: 'drill', x: 1, y: 2 });
  });

  it('serializes each command type', () => {
    const { net, ws } = connectedNet();
    net.roads([{ gx: 1, gy: 1 }]); expect(ws.lastSent()).toEqual({ t: 'roads', cells: [{ gx: 1, gy: 1 }] });
    net.control('OHT01', { dir: [1, 0] }); expect(ws.lastSent()).toEqual({ t: 'control', label: 'OHT01', dir: [1, 0] });
    net.assign('OHT01', 'HEX01'); expect(ws.lastSent()).toEqual({ t: 'assign', truck: 'OHT01', shovel: 'HEX01' });
    net.debug('OHT01', true); expect(ws.lastSent()).toEqual({ t: 'debug', label: 'OHT01', on: true });
    net.select('OHT01', false); expect(ws.lastSent()).toEqual({ t: 'select', label: 'OHT01', on: false });
    net.reset(); expect(ws.lastSent()).toEqual({ t: 'reset' });
    net.create(); expect(ws.lastSent()).toEqual({ t: 'create' });
  });

  it('join() re-opens the socket routed to the room (?room=) and joins on open', () => {
    const { net, ws } = connectedNet();
    net.join('abcde');                                   // typed code, lower-case
    const ws2 = FakeWebSocket.instances.at(-1);
    expect(ws2).not.toBe(ws);                            // a fresh socket, routed to the owner
    expect(ws2.url).toContain('room=ABCDE');
    expect(ws2.sent.length).toBe(0);                     // nothing sent until it opens
    ws2.open();
    expect(ws2.lastSent()).toEqual({ t: 'join', room: 'ABCDE' });
  });

  it('join() on a socket already routed to the room reuses it', () => {
    const net = new Net();
    net.join('XYZAB');                                   // sets _urlRoom + reconnects
    const ws = FakeWebSocket.instances.at(-1);
    ws.open();
    expect(ws.lastSent()).toEqual({ t: 'join', room: 'XYZAB' });
    net.join('XYZAB');                                   // same room — no new socket
    expect(FakeWebSocket.instances.at(-1)).toBe(ws);
    expect(ws.lastSent()).toEqual({ t: 'join', room: 'XYZAB' });
  });
});

describe('Net — receiving', () => {
  it('routes server frames to the matching callbacks', () => {
    const { net, ws } = connectedNet();
    const seen = {};
    net.onState = (s) => (seen.state = s);
    net.onLive = (m) => (seen.live = m);
    net.onRoads = (c) => (seen.roads = c);
    net.onVehicle = (v) => (seen.vehicle = v);
    net.onJoined = (r) => (seen.joined = r);
    net.onJoinError = (r) => (seen.err = r);

    ws.receive({ t: 'state', state: { credit: 5 } });
    ws.receive({ t: 'live', credit: 9, vehicles: [] });
    ws.receive({ t: 'roads', cells: [{ gx: 0, gy: 0 }] });
    ws.receive({ t: 'vehicle', vehicle: { label: 'OHT05' } });
    ws.receive({ t: 'joined', room: 'XYZAB' });
    ws.receive({ t: 'joinError', reason: 'room not found' });

    expect(seen.state).toEqual({ credit: 5 });
    expect(seen.live.credit).toBe(9);
    expect(seen.roads).toEqual([{ gx: 0, gy: 0 }]);
    expect(seen.vehicle.label).toBe('OHT05');
    expect(seen.joined).toBe('XYZAB');
    expect(seen.err).toBe('room not found');
    expect(net.room).toBe('XYZAB'); // joined also records the room
  });

  it('resolves drill() with the matching drilled frame', async () => {
    const { net, ws } = connectedNet();
    const p = net.drill(3, 4);
    ws.receive({ t: 'drilled', x: 3, y: 4, block: { explored: true }, credit: 95000 });
    await expect(p).resolves.toMatchObject({ credit: 95000, block: { explored: true } });
  });

  it('resolves buy() FIFO with the bought frame', async () => {
    const { net, ws } = connectedNet();
    const p = net.buy('T264');
    ws.receive({ t: 'bought', id: 'T264', ok: true, credit: 0, label: 'OHT05' });
    await expect(p).resolves.toMatchObject({ ok: true, label: 'OHT05' });
  });

  it('drill() resolves null on timeout', async () => {
    vi.useFakeTimers();
    const { net } = connectedNet();
    const p = net.drill(9, 9); // no server reply
    vi.advanceTimersByTime(3000);
    await expect(p).resolves.toBeNull();
  });
});
