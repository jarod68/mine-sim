// Single WebSocket link to the server. ALL client/server interaction goes
// through here — no HTTP polling. The server pushes `state` (full snapshot, on
// connect and after reset) and `live` (credit + vehicles + changed blocks every
// tick). The client sends commands (drill, roads, control, assign, reset).

export class Net {
  constructor() {
    this.ws = null;
    this.onState = null;     // (state) => void
    this.onLive = null;      // ({ credit, vehicles, blocks }) => void
    this.onRoads = null;     // (cells) => void  — another client edited the roads
    this._pendingDrill = new Map();
    this._buyQ = [];         // FIFO resolvers for buy() acknowledgements
    this._queue = [];        // commands buffered until the socket is open
    this._connect();
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.ws.onopen = () => { for (const m of this._queue) this.ws.send(m); this._queue.length = 0; };
    this.ws.onmessage = (e) => this._handle(JSON.parse(e.data));
    this.ws.onclose = () => setTimeout(() => this._connect(), 800); // auto-reconnect
  }

  _handle(m) {
    if (m.t === 'state') this.onState?.(m.state);
    else if (m.t === 'live') this.onLive?.(m);
    else if (m.t === 'roads') this.onRoads?.(m.cells);
    else if (m.t === 'drilled') {
      const k = `${m.x},${m.y}`;
      const r = this._pendingDrill.get(k);
      if (r) { this._pendingDrill.delete(k); r(m); }
    }
    else if (m.t === 'bought') {
      const r = this._buyQ.shift();
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

  roads(cells)            { this._send({ t: 'roads', cells }); }
  control(label, cmd)     { this._send({ t: 'control', label, ...cmd }); }
  assign(truck, shovel)   { this._send({ t: 'assign', truck, shovel }); }
  debug(label, on)        { this._send({ t: 'debug', label, on }); }
  select(label, on)       { this._send({ t: 'select', label, on }); }
  reset()                 { this._send({ t: 'reset' }); }
}
