// Drop-in replacement for the WebSocket `Net` client, for the full-local build.
// Exposes the exact same command methods and on* callbacks, but the transport is
// a Web Worker running the authoritative World locally instead of a server. The
// renderer (app.js + components/*) is unchanged — it can't tell the difference.
//
// The worker posts the same message shapes the server used to send over WS, so
// `_handle` / `_handlePositions` below are identical to Net's.

export class LocalEngine {
  constructor() {
    this.room = 'LOCAL';
    this.onState = null;     // (state) => void
    this.onLive = null;      // ({ credit, vehicles, blocks, ... }) => void
    this.onRoads = null;     // (cells) => void
    this.onRoadSpend = null; // (cost, gx, gy) => void
    this.onParking = null;   // (rect, cells) => void
    this.onPositions = null; // (records) => void  — binary vehicle position frame
    this.onJoined = null;    // (code) => void
    this.onJoinError = null; // (reason) => void
    this.onVehicle = null;   // (vehicle) => void
    this.onCrusher = null;   // (crusher, extraCrushers) => void
    this._pendingDrill = new Map();
    this._buyQ = [];
    this._crusherQ = [];

    // The module worker owns the simulation and IndexedDB persistence.
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this._handlePositions(e.data);
      else this._handle(e.data);
    };

    // Flush a save when the tab is backgrounded / closed (on top of autosave).
    if (typeof addEventListener === 'function') {
      addEventListener('pagehide', () => this._send({ t: 'save' }));
      addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this._send({ t: 'save' });
      });
    }

    // Auto-start: resume the saved game if there is one, else a fresh world.
    this._send({ t: 'init', load: true });
  }

  _handle(m) {
    if (m.t === 'joined') { this.room = m.room; this.onJoined?.(m.room); }
    else if (m.t === 'joinError') { this.onJoinError?.(m.reason); }
    else if (m.t === 'state') this.onState?.(m.state);
    else if (m.t === 'live') this.onLive?.(m);
    else if (m.t === 'roads') this.onRoads?.(m.cells);
    else if (m.t === 'roadSpend') this.onRoadSpend?.(m.cost, m.gx, m.gy);
    else if (m.t === 'parking') this.onParking?.(m.rect, m.cells);
    else if (m.t === 'vehicle') this.onVehicle?.(m.vehicle);
    else if (m.t === 'drilled') {
      const k = `${m.x},${m.y}`;
      const r = this._pendingDrill.get(k);
      if (r) { this._pendingDrill.delete(k); r(m); }
    }
    else if (m.t === 'bought') { const r = this._buyQ.shift(); if (r) r(m); }
    else if (m.t === 'crusher') this.onCrusher?.(m.crusher, m.extraCrushers);
    else if (m.t === 'crusherBought') { const r = this._crusherQ.shift(); if (r) r(m); }
  }

  // Decode the binary positions frame (see World.positionsDelta):
  // [u8 type=1][u16 count]{ u16 id, f32 x, f32 y, f32 heading, u16 gx, u16 gy ].
  _handlePositions(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 3 || dv.getUint8(0) !== 1) return;
    const n = dv.getUint16(1, true);
    const recs = [];
    let o = 3;
    for (let i = 0; i < n && o + 18 <= dv.byteLength; i++) {
      recs.push({
        id: dv.getUint16(o, true),
        x: dv.getFloat32(o + 2, true),
        y: dv.getFloat32(o + 6, true),
        heading: dv.getFloat32(o + 10, true),
        gx: dv.getUint16(o + 14, true),
        gy: dv.getUint16(o + 16, true),
      });
      o += 18;
    }
    this.onPositions?.(recs);
  }

  _send(o) { this.worker.postMessage(o); }

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

  // No rooms in local mode: "create" starts a fresh world (discarding the save on
  // the next tick), "join" simply resumes the local save. Kept for API parity.
  create() { this._send({ t: 'init', load: false }); }
  join()   { this._send({ t: 'init', load: true }); }

  roads(cells)          { this._send({ t: 'roads', cells }); }
  control(label, cmd)   { this._send({ t: 'control', label, ...cmd }); }
  moveTo(label, gx, gy) { this._send({ t: 'moveTo', label, gx, gy }); }
  assign(truck, shovel) { this._send({ t: 'assign', truck, shovel }); }
  debug(label, on)      { this._send({ t: 'debug', label, on }); }
  select(label, on)     { this._send({ t: 'select', label, on }); }
  resizeParking(rect)   { this._send({ t: 'resizeParking', rect }); }
  reset()               { this._send({ t: 'reset' }); }
  breakdown()           { this._send({ t: 'breakdown' }); }
}
