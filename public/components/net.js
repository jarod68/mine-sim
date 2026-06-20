// Single WebSocket link to the server. ALL client/server interaction goes
// through here — no HTTP polling. The server pushes `state` (full snapshot, on
// connect and after reset) and `live` (credit + vehicles + changed blocks every
// tick). The client sends commands (drill, roads, control, assign, reset).

export class Net {
  constructor() {
    this.ws = null;
    this.room = null;        // current room code (set once joined)
    // Room from the page URL — used only to route the FIRST connection to the
    // owning worker in cluster mode (harmless single-process). The lobby still
    // sends the join; `room` is set on 'joined'.
    try { this._urlRoom = new URL(location.href).searchParams.get('room')?.toUpperCase() || null; } catch { this._urlRoom = null; }
    this.onState = null;     // (state) => void
    this.onLive = null;      // ({ credit, vehicles, blocks }) => void
    this.onRoads = null;     // (cells) => void  — another client edited the roads
    this.onJoined = null;    // (code) => void
    this.onJoinError = null; // (reason) => void
    this.onVehicle = null;   // (vehicle) => void  — a new asset was bought
    this.onCrusher = null;   // (crusher, extraCrushers) => void  — a crusher was placed
    this._pendingDrill = new Map();
    this._buyQ = [];         // FIFO resolvers for buy() acknowledgements
    this._crusherQ = [];     // FIFO resolvers for buyCrusher() acknowledgements
    this._queue = [];        // commands buffered until the socket is open
    this._pendingJoin = null; // code to (re)join as soon as the socket opens
    this._connect();
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const code = this.room || this._urlRoom;     // route this socket to the room's worker
    const q = code ? `/?room=${encodeURIComponent(code)}` : '';
    this.ws = new WebSocket(`${proto}://${location.host}${q}`);
    this.ws.onopen = () => {
      // (Re)join first so this socket — and any queued commands — land in the room.
      const join = this.room || this._pendingJoin;
      if (join) this.ws.send(JSON.stringify({ t: 'join', room: join }));
      for (const m of this._queue) this.ws.send(m);
      this._queue.length = 0;
    };
    this.ws.onmessage = (e) => this._handle(JSON.parse(e.data));
    this.ws.onclose = () => setTimeout(() => this._connect(), 800); // auto-reconnect
  }

  // Deliberately drop the current socket and open a fresh one (e.g. to re-route to
  // a different worker). Suppresses the auto-reconnect of the socket being closed.
  _reconnect() {
    if (this.ws) { this.ws.onclose = null; this.ws.onerror = null; try { this.ws.close(); } catch { /* already gone */ } }
    this._connect();
  }

  _handle(m) {
    if (m.t === 'joined') { this.room = m.room; this._pendingJoin = null; this.onJoined?.(m.room); }
    else if (m.t === 'joinError') { this.onJoinError?.(m.reason); }
    else if (m.t === 'state') this.onState?.(m.state);
    else if (m.t === 'live') this.onLive?.(m);
    else if (m.t === 'roads') this.onRoads?.(m.cells);
    else if (m.t === 'vehicle') this.onVehicle?.(m.vehicle);
    else if (m.t === 'drilled') {
      const k = `${m.x},${m.y}`;
      const r = this._pendingDrill.get(k);
      if (r) { this._pendingDrill.delete(k); r(m); }
    }
    else if (m.t === 'bought') {
      const r = this._buyQ.shift();
      if (r) r(m);
    }
    else if (m.t === 'crusher') this.onCrusher?.(m.crusher, m.extraCrushers);
    else if (m.t === 'crusherBought') {
      const r = this._crusherQ.shift();
      if (r) r(m);
    }
  }

  _send(o) {
    const msg = JSON.stringify(o);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else this._queue.push(msg);
  }

  // Drill resolves with { block, credit } (or null on refusal/timeout).
  drill(x, y) {
    const k = `${x},${y}`;
    return new Promise((resolve) => {
      this._pendingDrill.set(k, resolve);
      this._send({ t: 'drill', x, y });
      setTimeout(() => {
        if (this._pendingDrill.has(k)) { this._pendingDrill.delete(k); resolve(null); }
      }, 3000);
    });
  }

  // Buy an asset; resolves with { ok, credit, label } or { error, credit }.
  buy(id) {
    return new Promise((resolve) => {
      this._buyQ.push(resolve);
      this._send({ t: 'buy', id });
      setTimeout(() => {
        const i = this._buyQ.indexOf(resolve);
        if (i >= 0) { this._buyQ.splice(i, 1); resolve(null); }
      }, 3000);
    });
  }

  // Buy + place a crusher at (gx,gy); resolves with { ok, credit, extraCrushers } or { error }.
  buyCrusher(gx, gy) {
    return new Promise((resolve) => {
      this._crusherQ.push(resolve);
      this._send({ t: 'buyCrusher', gx, gy });
      setTimeout(() => {
        const i = this._crusherQ.indexOf(resolve);
        if (i >= 0) { this._crusherQ.splice(i, 1); resolve(null); }
      }, 3000);
    });
  }

  create()                { this._send({ t: 'create' }); }

  // Join an existing room by code. In cluster mode the room lives on the single
  // worker that owns its code, and the gateway routes connections by `?room=`.
  // The lobby socket may be on a different worker, so re-open it routed to the
  // owner before joining (harmless single-process). The join is sent on open.
  join(room) {
    const code = String(room).toUpperCase();
    this._pendingJoin = code;
    if (this._urlRoom === code) {
      // already routed to this room's worker — just (re)send the join
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'join', room: code }));
      return;
    }
    this._urlRoom = code;
    this._reconnect();
  }

  roads(cells)            { this._send({ t: 'roads', cells }); }
  control(label, cmd)     { this._send({ t: 'control', label, ...cmd }); }
  moveTo(label, gx, gy)   { this._send({ t: 'moveTo', label, gx, gy }); }
  assign(truck, shovel)   { this._send({ t: 'assign', truck, shovel }); }
  debug(label, on)        { this._send({ t: 'debug', label, on }); }
  select(label, on)       { this._send({ t: 'select', label, on }); }
  resizeParking(rect)     { this._send({ t: 'resizeParking', rect }); }
  reset()                 { this._send({ t: 'reset' }); }
}
