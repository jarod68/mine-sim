// The authoritative road network (drawn one-way cells + parking pads + crusher
// footprints). The client has its own editor/renderer copy in public/components.

const { key, ROAD_WEAR_LIMIT } = require('./constants');

class Roads {
  constructor(grid) {
    this.grid = grid;
    this.cells = new Map();   // "gx,gy" -> { gx, gy, dir:{dx,dy}|null, parking, wear }
    this.parkings = [];
    this.crushers = [];       // [{ x, y, w, h }]
    this._worn = new Set();   // keys of degraded (wear ≥ limit) non-parking cells
  }

  isRoad(gx, gy) { return this.cells.has(key(gx, gy)); }

  _ensure(gx, gy) {
    const k = key(gx, gy);
    if (!this.cells.has(k)) this.cells.set(k, { gx, gy, dir: null, wear: 0 });
    return this.cells.get(k);
  }

  addParking(x, y, w, h) {
    this.parkings.push({ x, y, w, h });
    for (let gy = y; gy < y + h; gy++)
      for (let gx = x; gx < x + w; gx++) this._ensure(gx, gy).parking = true;
  }

  setCrushers(list) { this.crushers = Array.isArray(list) ? list : []; }

  // ── road wear ──────────────────────────────────────────────────────────────
  // One vehicle pass over a drivable road cell (parking pads never wear). Returns
  // true only on the pass that tips the cell over the degradation threshold, so
  // the caller can flag it for a "worn" broadcast.
  wearPass(gx, gy) {
    const c = this.cells.get(key(gx, gy));
    if (!c || c.parking) return false;
    c.wear = (c.wear || 0) + 1;
    if (c.wear === ROAD_WEAR_LIMIT) { this._worn.add(key(gx, gy)); return true; }
    return false;
  }

  // A grader pass restores a cell. Returns true if it was degraded (so the caller
  // can broadcast that it's smooth again).
  repairCell(gx, gy) {
    const c = this.cells.get(key(gx, gy));
    if (!c || c.parking) return false;
    const wasWorn = (c.wear || 0) >= ROAD_WEAR_LIMIT;
    c.wear = 0;
    if (wasWorn) { this._worn.delete(key(gx, gy)); return true; }
    return false;
  }

  isWorn(gx, gy) {
    const c = this.cells.get(key(gx, gy));
    return !!(c && !c.parking && (c.wear || 0) >= ROAD_WEAR_LIMIT);
  }

  wornKeys() { return this._worn; }

  // Replace the drawn road network (keeps parking pads intact). A malformed
  // payload is ignored — it must never wipe the existing roads. Per-cell wear is
  // preserved across edits (re-drawing a road keeps its degradation) and restored
  // from a snapshot when the payload carries it.
  setNetwork(cells) {
    if (!Array.isArray(cells)) return;
    const prevWear = new Map();
    for (const [k, c] of this.cells) if (!c.parking && c.wear) prevWear.set(k, c.wear);
    for (const [k, c] of [...this.cells]) if (!c.parking) this.cells.delete(k);
    this._worn = new Set();
    for (const c of cells) {
      if (!Number.isInteger(c.gx) || !Number.isInteger(c.gy)) continue;
      const cell = this._ensure(c.gx, c.gy);
      cell.dir = c.dir || null;
      const k = key(c.gx, c.gy);
      cell.wear = (typeof c.wear === 'number' ? c.wear : prevWear.get(k)) || 0;
      if (cell.wear >= ROAD_WEAR_LIMIT) this._worn.add(k);
    }
  }

  serialize() {
    const out = [];
    for (const c of this.cells.values()) {
      if (c.parking) continue;
      const cell = { gx: c.gx, gy: c.gy, dir: c.dir };
      if (c.wear) cell.wear = c.wear;                 // carry degradation for sync + restore
      out.push(cell);
    }
    return out;
  }
}

module.exports = { Roads };
