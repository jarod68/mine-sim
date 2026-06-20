// The authoritative road network (drawn one-way cells + parking pads + crusher
// footprints). The client has its own editor/renderer copy in public/components.

const { key } = require('./constants');

class Roads {
  constructor(grid) {
    this.grid = grid;
    this.cells = new Map();   // "gx,gy" -> { gx, gy, dir:{dx,dy}|null, parking }
    this.parkings = [];
    this.crushers = [];       // [{ x, y, w, h }]
  }

  isRoad(gx, gy) { return this.cells.has(key(gx, gy)); }

  _ensure(gx, gy) {
    const k = key(gx, gy);
    if (!this.cells.has(k)) this.cells.set(k, { gx, gy, dir: null });
    return this.cells.get(k);
  }

  addParking(x, y, w, h) {
    this.parkings.push({ x, y, w, h });
    for (let gy = y; gy < y + h; gy++)
      for (let gx = x; gx < x + w; gx++) this._ensure(gx, gy).parking = true;
  }

  setCrushers(list) { this.crushers = Array.isArray(list) ? list : []; }

  // Replace the drawn road network (keeps parking pads intact). A malformed
  // payload is ignored — it must never wipe the existing roads.
  setNetwork(cells) {
    if (!Array.isArray(cells)) return;
    for (const [k, c] of [...this.cells]) if (!c.parking) this.cells.delete(k);
    for (const c of cells) {
      if (!Number.isInteger(c.gx) || !Number.isInteger(c.gy)) continue;
      const cell = this._ensure(c.gx, c.gy);
      cell.dir = c.dir || null;
    }
  }

  serialize() {
    const out = [];
    for (const c of this.cells.values()) {
      if (c.parking) continue;
      out.push({ gx: c.gx, gy: c.gy, dir: c.dir });
    }
    return out;
  }
}

module.exports = { Roads };
