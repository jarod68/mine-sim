// Authoritative server-side world. ALL gameplay state lives here and is advanced
// by tick(dt): vehicle movement, anti-collision, the haul autopilot, shovel
// relocation, loading/unloading, payouts. The client only renders snapshots and
// sends commands (drill, edit roads, drive manually, assign, reset).

const { generateMine, BLOCK_TONNAGE } = require('./mine');

// View space shared with the client renderer (so x/y come ready to draw).
// Map area ×15 of the original (×5 of the previous), view scaled to keep the
// block/vehicle size constant.
const VIEW_W = 7942;
const VIEW_H = 5560;
const COLS = 190;
const ROWS = 139;

// One crusher per ~5000 blocks on average.
const BLOCKS_PER_CRUSHER = 5000;

const STARTING_CREDIT = 100000;
const DRILL_COST = 5000;

const ORE_VALUE = {
  iron:   10000 / 240,
  copper: 16000 / 240,
  gold:   60000 / 240,
  carbon:  6000 / 240,
};

const PARKING = { x: 3, y: 2, w: 6, h: 3 };
const PARK_BLOCKS = {
  bx0: Math.floor(PARKING.x / 2),
  by0: Math.floor(PARKING.y / 2),
  bx1: Math.floor((PARKING.x + PARKING.w - 1) / 2),
  by1: Math.floor((PARKING.y + PARKING.h - 1) / 2),
};

// ── Vehicle ─────────────────────────────────────────────────────────────────

const BASE_SPEED = 168; // px/s

const SPECS = {
  pickup:    { model: 'Light Utility Vehicle' },
  excavator: { model: 'Liebherr R9400', bucket: 40 },
  oht:       { model: 'Liebherr T264', payload: 240 },
};

// Excavator reference models. `scale` multiplies the base visual size.
const EXCAVATORS = {
  R9400: { model: 'Liebherr R9400', bucket: 40, scale: 1.0 },
  R9600: { model: 'Liebherr R9600', bucket: 60, scale: 1.275 },
  R9800: { model: 'Liebherr R9800', bucket: 75, scale: 1.275 * 1.5 }, // 1.5× the R9600
};

// Buyable assets (shop). Prices in $.
const MAX_ASSETS = 25;
const CATALOG = [
  { id: 'LV',    type: 'pickup',    model: 'Light Utility Vehicle', price: 25000,  spec: 'Manual scout vehicle' },
  { id: 'T264',  type: 'oht',       model: 'Liebherr T264',         price: 100000, spec: 'Haul truck — 240 t payload' },
  { id: 'R9400', type: 'excavator', model: 'Liebherr R9400',        price: 400000, spec: 'Shovel — 40 t bucket' },
  { id: 'R9600', type: 'excavator', model: 'Liebherr R9600',        price: 600000, spec: 'Shovel — 60 t bucket' },
  { id: 'R9800', type: 'excavator', model: 'Liebherr R9800',        price: 800000, spec: 'Shovel — 75 t bucket' },
];

class Vehicle {
  constructor({ type, label, gx, gy, len, wid, model, bucket, payload }) {
    this.type = type;
    this.label = label;
    this.gx = gx; this.gy = gy;
    this.tgx = gx; this.tgy = gy;
    this.len = len; this.wid = wid;
    this.speed = type === 'excavator' ? BASE_SPEED / 4
      : type === 'oht' ? BASE_SPEED / 2 : BASE_SPEED;
    this.roadOnly = type === 'oht';
    const spec = SPECS[type] || {};
    this.model = model || spec.model || type;
    this.payload = payload ?? spec.payload ?? null;
    this.bucket = bucket ?? spec.bucket ?? null;
    this.x = 0; this.y = 0;
    this.heading = 0;
    this.moving = false;
    this.load = 0;
    this.loadOre = null;
    this.task = null;
    this.digging = false;
    this.manual = false;
    this.manualDir = null;
  }

  place(grid) {
    this.x = (this.gx + 0.5) * grid.zoneW;
    this.y = (this.gy + 0.5) * grid.zoneH;
  }

  update(dt, dir, grid, isRoad, isFree) {
    if (this.moving) {
      const tx = (this.tgx + 0.5) * grid.zoneW;
      const ty = (this.tgy + 0.5) * grid.zoneH;
      const dx = tx - this.x;
      const dy = ty - this.y;
      const dist = Math.hypot(dx, dy);
      const step = this.speed * dt;
      if (dist <= step) {
        this.x = tx; this.y = ty;
        this.gx = this.tgx; this.gy = this.tgy;
        this.moving = false;
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }
    }

    if (!this.moving && dir) {
      const [dx, dy] = dir;
      this.heading = Math.atan2(dy, dx);
      const nx = this.gx + dx;
      const ny = this.gy + dy;
      const inBounds = nx >= 0 && nx < grid.zoneCols && ny >= 0 && ny < grid.zoneRows;
      const onRoad = !this.roadOnly || this.manual || (isRoad && isRoad(nx, ny));
      const cells = this.cellsAround(nx, ny, { dx, dy }, grid);
      const free = !isFree || cells.every((c) => isFree(c.gx, c.gy, this));
      if (inBounds && onRoad && free) {
        this.tgx = nx; this.tgy = ny;
        this.moving = true;
      }
    }
  }

  cellsAround(gx, gy, dir, grid) {
    const zone = Math.min(grid.zoneW, grid.zoneH);
    const lenCells = Math.max(1, Math.round(this.len / zone));
    const cells = [];
    for (let i = 0; i < lenCells; i++) cells.push({ gx: gx - dir.dx * i, gy: gy - dir.dy * i });
    return cells;
  }

  occupiedCells(grid) {
    const dir = { dx: Math.round(Math.cos(this.heading)), dy: Math.round(Math.sin(this.heading)) };
    const cells = this.cellsAround(this.gx, this.gy, dir, grid);
    if (this.moving) for (const c of this.cellsAround(this.tgx, this.tgy, dir, grid)) cells.push(c);
    return cells;
  }
}

// ── Roads ───────────────────────────────────────────────────────────────────

const rkey = (gx, gy) => `${gx},${gy}`;

class Roads {
  constructor(grid) {
    this.grid = grid;
    this.cells = new Map();   // "gx,gy" -> { gx, gy, dir:{dx,dy}|null, parking }
    this.parkings = [];
    this.crushers = [];       // [{ x, y, w, h }]
  }

  isRoad(gx, gy) { return this.cells.has(rkey(gx, gy)); }

  _ensure(gx, gy) {
    const k = rkey(gx, gy);
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

// ── Autopilot (ported, fully synchronous) ───────────────────────────────────

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BUCKET_TIME = 1.5;          // s per bucket pass
const TRUCK_CAP = 240;            // truck payload (t)
const DUMP_TIME = 5;              // s to dump at the crusher
const PARK_RECHECK = 0.4;

const key = (gx, gy) => `${gx},${gy}`;

class Autopilot {
  constructor(grid, roads, hooks) {
    this.grid = grid;
    this.roads = roads;
    this.hooks = hooks;
    this.enabled = false;
    this.links = new Map();
    this.state = new Map();
    this._shovelLock = new Map();
    this._crusherLocks = new Map();  // crusher index → truck currently dumping
    this._bayCache = null;           // cached crusher bay cells (key → crusher idx)
    this.shovels = new Set();
    this._shovelMove = new Map();
    this._manual = new Set();
    this._selected = new Set();   // assets a client is currently inspecting
    this.isFree = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) { for (const t of this.links.keys()) this._ensure(t); }
    else {
      for (const t of this.links.keys()) t.task = null;
      this._shovelLock.clear();
      this._crusherLocks.clear();
      this._shovelMove.clear();
    }
  }

  addShovel(shovel) { if (shovel) this.shovels.add(shovel); }

  setManual(v) {
    this._manual.add(v);
    this._shovelMove.delete(v);
    this._freeLocks(v);
    v.task = null;
  }

  clearManual(v) {
    if (!this._manual.has(v)) return;
    this._manual.delete(v);
    const st = this.state.get(v);
    if (st) { st.phase = v.load > 0 ? 'to_crusher' : 'to_shovel'; st.dir = null; st.timer = 0; }
  }

  isManual(v) { return this._manual.has(v); }

  assign(truck, shovel) {
    this._freeLocks(truck);
    if (shovel) { this.links.set(truck, shovel); this.shovels.add(shovel); }
    else { this.links.delete(truck); this.state.delete(truck); truck.task = null; }
    this._ensure(truck);
  }

  assignedShovel(t) { return this.links.get(t) ?? null; }

  controls(v) {
    if (!this.enabled || this._manual.has(v)) return false;
    return this.links.has(v) || this._shovelMove.has(v);
  }

  dirFor(v) {
    if (this._shovelMove.has(v)) return this._shovelStep(v);
    return this.state.get(v)?.dir ?? null;
  }

  update(dt) {
    if (!this.enabled) return;
    for (const s of this.shovels) s.digging = false;
    for (const [truck, shovel] of this.links) this._tick(dt, truck, shovel);
    this._updateShovels();
  }

  _shovelHolder(shovel)          { return this._shovelLock.get(shovel) ?? null; }
  _canTakeShovel(shovel, truck)  { const h = this._shovelHolder(shovel); return !h || h === truck; }
  _tryLockShovel(shovel, truck)  { if (this._canTakeShovel(shovel, truck)) { this._shovelLock.set(shovel, truck); return true; } return false; }
  _unlockShovel(shovel, truck)   { if (this._shovelLock.get(shovel) === truck) this._shovelLock.delete(shovel); }
  _canTakeCrusher(idx, truck)    { const h = this._crusherLocks.get(idx); return !h || h === truck; }
  _tryLockCrusher(idx, truck)    { if (this._canTakeCrusher(idx, truck)) { this._crusherLocks.set(idx, truck); return true; } return false; }
  _unlockCrusher(idx, truck)     { if (this._crusherLocks.get(idx) === truck) this._crusherLocks.delete(idx); }

  _freeLocks(truck) {
    for (const [s, h] of this._shovelLock) if (h === truck) this._shovelLock.delete(s);
    for (const [i, h] of this._crusherLocks) if (h === truck) this._crusherLocks.delete(i);
  }

  _updateShovels() {
    for (const shovel of this.shovels) {
      const move = this._shovelMove.get(shovel);
      if (move) {
        // Re-evaluate the in-progress relocation each tick: stop on arrival, or
        // abandon the trip if the target block lost its ore (e.g. another shovel
        // got there first) so it re-picks a fresh destination below.
        const arrived = !shovel.moving && shovel.gx === move.gx && shovel.gy === move.gy;
        const tb = this.hooks.getBlock(Math.floor(move.gx / 2), Math.floor(move.gy / 2));
        const targetHasOre = tb && tb.ore && tb.oreRemaining > 0;
        if (arrived || !targetHasOre) this._shovelMove.delete(shovel);
        else continue;
      }
      // Don't auto-relocate a shovel the player is driving or inspecting.
      if (this._manual.has(shovel) || this._selected.has(shovel)) continue;
      if (shovel.digging) continue;
      const bx = Math.floor(shovel.gx / 2);
      const by = Math.floor(shovel.gy / 2);
      const here = this.hooks.getBlock(bx, by);
      // Productive only on an explored block that still has ore → keep mining.
      if (here && here.explored && here.ore && here.oreRemaining > 0) continue;
      // Otherwise relocate to the best EXPLORED ore block within 3 blocks.
      // Relocation never reveals undrilled ground, and never moves onto a road.
      const next = this._bestOreInRadius(bx, by, 3);
      if (next) {
        this._shovelMove.set(shovel, {
          gx: next.bx * 2 + (shovel.gx % 2),
          gy: next.by * 2 + (shovel.gy % 2),
        });
      }
    }
  }

  // Does any sub-zone of block (bx,by) sit on a road? Used to keep shovels OFF
  // the roads when relocating.
  _blockOnRoad(bx, by) {
    for (let gy = by * 2; gy <= by * 2 + 1; gy++)
      for (let gx = bx * 2; gx <= bx * 2 + 1; gx++)
        if (this.roads.isRoad(gx, gy)) return true;
    return false;
  }

  // Best EXPLORED ore block within `R` blocks (Chebyshev) of (bx,by) to move to.
  // Never reveals undrilled ground and never a block that lies on a road.
  // Priority: blocks adjacent to a road (a bay, so trucks can reach) win; then
  // the nearest; then the richest. Returns { bx, by } or null.
  _bestOreInRadius(bx, by, R) {
    let best = null;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nbx = bx + dx;
        const nby = by + dy;
        const b = this.hooks.getBlock(nbx, nby);
        if (!(b && b.explored && b.ore && b.oreRemaining > 0)) continue;
        if (this._blockOnRoad(nbx, nby)) continue;       // never sit on a road
        const hasRoad = this._bayCells(nbx * 2, nby * 2, nbx * 2 + 1, nby * 2 + 1).size > 0;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const cand = { bx: nbx, by: nby, ore: b.oreRemaining, hasRoad, dist };
        if (!best || this._betterOreTarget(cand, best)) best = cand;
      }
    }
    return best;
  }

  // Ranking: road access first, then proximity, then ore quantity.
  _betterOreTarget(a, b) {
    if (a.hasRoad !== b.hasRoad) return a.hasRoad;
    if (a.dist !== b.dist) return a.dist < b.dist;
    return a.ore > b.ore;
  }

  setSelected(v, on) {
    if (!v) return;
    if (on) this._selected.add(v); else this._selected.delete(v);
  }

  _shovelStep(shovel) {
    const t = this._shovelMove.get(shovel);
    if (!t) return null;
    const cx = shovel.moving ? shovel.tgx : shovel.gx;
    const cy = shovel.moving ? shovel.tgy : shovel.gy;
    const dx = Math.sign(t.gx - cx);
    const dy = Math.sign(t.gy - cy);
    return (dx === 0 && dy === 0) ? null : [dx, dy];
  }

  _ensure(truck) {
    if (!this.links.has(truck) || this.state.get(truck)) return;
    this.state.set(truck, { phase: 'to_shovel', dir: null, timer: 0, bucket: 0 });
  }

  // The block a shovel is (or will be) working: its relocation TARGET while it
  // is moving, otherwise its current block. Trucks aim at this so they never
  // chase the shovel's transient position during a relocation.
  _shovelBlock(shovel) {
    const mv = this._shovelMove.get(shovel);
    const gx = mv ? mv.gx : shovel.gx;
    const gy = mv ? mv.gy : shovel.gy;
    return { bx: Math.floor(gx / 2), by: Math.floor(gy / 2) };
  }

  _tick(dt, truck, shovel) {
    const st = this.state.get(truck);
    if (!st) return;
    if (this._manual.has(truck)) { st.dir = null; return; }
    const sb = this._shovelBlock(shovel);

    switch (st.phase) {
      case 'loading':    st.dir = null; shovel.digging = true; this._doLoad(dt, truck, shovel, sb, st); return;
      case 'dumping':    st.dir = null; this._doDump(dt, truck, st); return;
      case 'parked':     this._tickParked(dt, truck, shovel, sb, st); return;
      case 'to_shovel':  this._tickToShovel(truck, shovel, sb, st); return;
      case 'to_crusher': this._tickToCrusher(truck, st); return;
      case 'to_parking': this._tickToParking(truck, st); return;
      default:           st.phase = 'to_shovel'; st.dir = null; return;
    }
  }

  _tickToShovel(truck, shovel, sb, st) {
    truck.task = null;
    const block = this.hooks.getBlock(sb.bx, sb.by);
    const hasOre = block && block.explored && block.ore && block.oreRemaining > 0;
    if (!hasOre) {
      this._unlockShovel(shovel, truck);
      st.phase = truck.load > 0 ? 'to_crusher' : 'to_parking';
      st.dir = null; return;
    }
    const goals = this._shovelGoals(sb);
    const from = this._logical(truck);
    if (!goals.size || !this._reachStatic(from, goals)) {
      st.phase = truck.load > 0 ? 'to_crusher' : 'to_parking';
      st.dir = null; return;
    }
    const a = this._advance(truck, goals, () => this._canTakeShovel(shovel, truck));
    if (a.arrived) {
      if (this._tryLockShovel(shovel, truck)) { st.phase = 'loading'; st.timer = 0; st.bucket = 0; truck.load = 0; }
      st.dir = null; return;
    }
    st.dir = a.dir;
  }

  _tickToCrusher(truck, st) {
    truck.task = null;
    const bays = this._crusherBays();           // cell key → crusher index
    if (!bays.size) { st.phase = 'to_parking'; st.dir = null; return; }
    const goals = new Set(bays.keys());
    const from = this._logical(truck);
    if (!this._reachStatic(from, goals)) { st.phase = 'to_parking'; st.dir = null; return; }
    // The BFS heads to the NEAREST crusher bay; the gate prevents claiming a bay
    // whose crusher is busy.
    const a = this._advance(truck, goals, (nx, ny) => {
      const idx = bays.get(key(nx, ny));
      return idx != null && this._canTakeCrusher(idx, truck);
    });
    if (a.arrived) {
      const lc = this._logical(truck);
      const idx = bays.get(key(lc.gx, lc.gy));
      if (idx != null && this._tryLockCrusher(idx, truck)) {
        st.phase = 'dumping'; st.timer = 0; st.crusherIdx = idx;
      }
      st.dir = null; return;
    }
    st.dir = a.dir;
  }

  _tickToParking(truck, st) {
    truck.task = null;

    // Re-evaluate every tick: only head to the parking if there is genuinely
    // nothing useful to do. The instant a job becomes possible — a load to
    // deliver, or an assigned shovel with reachable ore — redirect immediately
    // via the shortest route instead of finishing the trip to the parking.
    if (this._redirectIfUseful(truck, st)) return;

    const slot = this._parkSlot(truck);
    if (!slot) { st.dir = null; return; }
    const goals = new Set([key(slot.gx, slot.gy)]);
    const a = this._advance(truck, goals, null);
    if (a.arrived) { st.phase = 'parked'; st.timer = 0; st.dir = null; return; }
    st.dir = a.dir;
  }

  // If the truck can do something useful right now, switch its phase and return
  // true. Loaded → deliver at the crusher; empty → fetch ore from its shovel.
  // Reachability ignores other vehicles so a momentary jam never blocks a redirect.
  _redirectIfUseful(truck, st) {
    const from = this._logical(truck);
    if (truck.load > 0) {
      if (this._reachStatic(from, this._crusherGoals())) {
        this._releaseSlot(truck); st.phase = 'to_crusher'; st.dir = null; return true;
      }
      return false;
    }
    const shovel = this.links.get(truck);
    if (!shovel) return false;
    const sb = this._shovelBlock(shovel);
    const block = this.hooks.getBlock(sb.bx, sb.by);
    const hasOre = block && block.explored && block.ore && block.oreRemaining > 0;
    if (hasOre && this._reachStatic(from, this._shovelGoals(sb))) {
      this._releaseSlot(truck); st.phase = 'to_shovel'; st.dir = null; return true;
    }
    return false;
  }

  _tickParked(dt, truck, shovel, sb, st) {
    st.dir = null;
    truck.task = null;
    st.timer += dt;
    if (st.timer < PARK_RECHECK) return;
    st.timer = 0;
    this._redirectIfUseful(truck, st);   // resume the instant a job is possible
  }

  _doLoad(dt, truck, shovel, sb, st) {
    const block = this.hooks.getBlock(sb.bx, sb.by);
    if (!block || !block.explored || !block.ore || block.oreRemaining <= 0) {
      truck.task = null;
      st.timer += dt;
      if (st.timer >= 0.4) {
        this._unlockShovel(shovel, truck);
        st.phase = truck.load > 0 ? 'to_crusher' : 'to_parking';
        st.timer = 0;
      }
      return;
    }
    // Bucket capacity is per shovel model (R9400 = 40 t, R9600 = 60 t): a bigger
    // bucket fills the truck in fewer passes.
    const bload = shovel.bucket || 40;
    const passes = Math.max(1, Math.ceil(TRUCK_CAP / bload));
    st.timer += dt;
    if (st.timer >= BUCKET_TIME) {
      st.timer -= BUCKET_TIME;
      st.bucket++;
      truck.load = Math.min(TRUCK_CAP, truck.load + bload);
      truck.loadOre = block.ore;
    }
    truck.task = { kind: 'load', progress: Math.min(1, (st.bucket + st.timer / BUCKET_TIME) / passes) };
    if (st.bucket >= passes || truck.load >= TRUCK_CAP) {
      truck.load = this.hooks.mineBlock(sb.bx, sb.by, truck.load);
      this._unlockShovel(shovel, truck);
      truck.task = null;
      st.phase = 'to_crusher'; st.timer = 0; st.bucket = 0;
    }
  }

  _doDump(dt, truck, st) {
    if (st.dumpTotal == null) { st.dumpTotal = truck.load; st.dumpOre = truck.loadOre; }
    st.timer += dt;
    const progress = Math.min(1, st.timer / DUMP_TIME);
    truck.task = { kind: 'dump', progress };
    truck.load = st.dumpTotal * (1 - progress);
    if (st.timer >= DUMP_TIME) {
      if (st.dumpTotal > 0) this.hooks.deliver(st.dumpOre, st.dumpTotal);
      this._unlockCrusher(st.crusherIdx, truck);
      truck.load = 0; truck.loadOre = null; truck.task = null;
      st.dumpTotal = null; st.dumpOre = null; st.crusherIdx = null;
      st.phase = 'to_shovel'; st.timer = 0;
    }
  }

  _logical(truck) {
    return truck.moving ? { gx: truck.tgx, gy: truck.tgy } : { gx: truck.gx, gy: truck.gy };
  }

  _advance(truck, goals, gate) {
    const lc = this._logical(truck);
    if (goals.has(key(lc.gx, lc.gy))) return { arrived: !truck.moving, dir: null };
    let dir = this._nextDir(lc, goals, truck);
    if (dir && gate) {
      const nx = lc.gx + dir[0];
      const ny = lc.gy + dir[1];
      if (goals.has(key(nx, ny)) && !gate(nx, ny)) dir = null;
    }
    return { arrived: false, dir };
  }

  _shovelGoals(sb) { return this._bayCells(sb.bx * 2, sb.by * 2, sb.bx * 2 + 1, sb.by * 2 + 1); }

  // Map of every crusher bay cell key → its crusher index (cached; invalidated
  // when the road network changes).
  _crusherBays() {
    if (this._bayCache) return this._bayCache;
    const map = new Map();
    this.roads.crushers.forEach((cr, idx) => {
      for (const k of this._bayCells(cr.x, cr.y, cr.x + cr.w - 1, cr.y + cr.h - 1)) map.set(k, idx);
    });
    this._bayCache = map;
    return map;
  }

  _crusherGoals() { return new Set(this._crusherBays().keys()); }

  _bayCells(x0, y0, x1, y1) {
    const set = new Set();
    for (const c of this.roads.cells.values()) {
      if (c.parking) continue;
      const inX = c.gx >= x0 && c.gx <= x1;
      const inY = c.gy >= y0 && c.gy <= y1;
      const adjV = inX && (c.gy === y0 - 1 || c.gy === y1 + 1);
      const adjH = inY && (c.gx === x0 - 1 || c.gx === x1 + 1);
      if (adjV || adjH) set.add(key(c.gx, c.gy));
    }
    return set;
  }

  _buildSlots() {
    this._slots = [];
    this._slotByTruck = new Map();
    for (const p of this.roads.parkings || [])
      for (let gy = p.y; gy < p.y + p.h; gy++)
        for (let gx = p.x; gx < p.x + p.w; gx += 2)
          this._slots.push({ gx, gy });
  }

  _parkSlot(truck) {
    if (!this._slots) this._buildSlots();
    let s = this._slotByTruck.get(truck);
    if (!s) {
      const taken = new Set([...this._slotByTruck.values()].map((v) => key(v.gx, v.gy)));
      s = this._slots.find((v) => !taken.has(key(v.gx, v.gy)));
      if (s) this._slotByTruck.set(truck, s);
    }
    return s ?? null;
  }

  _releaseSlot(truck) { if (this._slotByTruck) this._slotByTruck.delete(truck); }

  _nextDir(from, goals, truck) {
    const path = this._pathToward(from, goals, truck);
    if (path && path.length >= 2) return [path[1].gx - path[0].gx, path[1].gy - path[0].gy];
    return null;
  }

  _pathToward(from, goals, truck) {
    if (!this.roads.isRoad(from.gx, from.gy)) return null;
    const startKey = key(from.gx, from.gy);
    const queue = [{ gx: from.gx, gy: from.gy }];
    const seen = new Set([startKey]);
    const prev = new Map();
    const goalPts = [...goals].map((k) => { const [x, y] = k.split(','); return { gx: +x, gy: +y }; });
    const distToGoals = (gx, gy) => {
      let d = Infinity;
      for (const g of goalPts) d = Math.min(d, Math.abs(gx - g.gx) + Math.abs(gy - g.gy));
      return d;
    };
    let bestCell = null; let bestDist = Infinity;
    while (queue.length) {
      const c = queue.shift();
      const ck = key(c.gx, c.gy);
      if (ck !== startKey) {
        if (goals.has(ck)) return this._reconstruct(prev, c);
        const d = distToGoals(c.gx, c.gy);
        if (d < bestDist) { bestDist = d; bestCell = c; }
      }
      for (const n of this._neighbors(c)) {
        const nk = key(n.gx, n.gy);
        if (seen.has(nk)) continue;
        if (this.isFree && !goals.has(nk) && !this.isFree(n.gx, n.gy, truck)) continue;
        seen.add(nk); prev.set(nk, c); queue.push(n);
      }
    }
    return bestCell ? this._reconstruct(prev, bestCell) : null;
  }

  _reachStatic(from, goals) {
    if (!goals || !goals.size) return false;
    if (!this.roads.isRoad(from.gx, from.gy)) return false;
    if (goals.has(key(from.gx, from.gy))) return true;
    const queue = [{ gx: from.gx, gy: from.gy }];
    const seen = new Set([key(from.gx, from.gy)]);
    while (queue.length) {
      const c = queue.shift();
      for (const n of this._neighbors(c)) {
        const nk = key(n.gx, n.gy);
        if (seen.has(nk)) continue;
        if (goals.has(nk)) return true;
        seen.add(nk); queue.push(n);
      }
    }
    return false;
  }

  _reconstruct(prev, cell) {
    const path = [cell];
    let k = key(cell.gx, cell.gy);
    while (prev.has(k)) { const p = prev.get(k); path.unshift(p); k = key(p.gx, p.gy); }
    return path;
  }

  // Successors respecting one-way flow. The ONLY constraint is that you may not
  // enter a cell against its arrow. A cell's own direction never restricts how
  // you LEAVE it, so at a T or X junction every turn (and going straight) is
  // allowed as long as the cell entered isn't taken the wrong way. U-turns are
  // naturally blocked: the cell behind you flows toward you, so re-entering it
  // is against its flow. Parking cells (no direction) are omnidirectional.
  _neighbors(c) {
    const out = [];
    for (const [dx, dy] of DIRS) {
      const nx = c.gx + dx;
      const ny = c.gy + dy;
      if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
      if (!this.roads.isRoad(nx, ny)) continue;
      const nc = this.roads.cells.get(key(nx, ny));
      const nDir = (nc && !nc.parking) ? nc.dir : null;
      if (nDir && dx === -nDir.dx && dy === -nDir.dy) continue; // never enter against the flow
      out.push({ gx: nx, gy: ny });
    }
    return out;
  }

  // Debug: the cells this vehicle is currently routing through and its goal
  // cells, for on-map visualisation. Returns { path:[{gx,gy}], goals:[{gx,gy}] }.
  debugPlan(v) {
    // A relocating shovel: straight hop to its target block.
    if (this._shovelMove.has(v)) {
      const t = this._shovelMove.get(v);
      return { path: [{ gx: v.gx, gy: v.gy }, { gx: t.gx, gy: t.gy }], goals: [{ gx: t.gx, gy: t.gy }] };
    }
    const st = this.state.get(v);
    if (!st || this._manual.has(v)) return null;

    let goals = null;
    if (st.phase === 'to_shovel') {
      const s = this.links.get(v);
      if (s) goals = this._shovelGoals(this._shovelBlock(s));
    } else if (st.phase === 'to_crusher') {
      goals = this._crusherGoals();
    } else if (st.phase === 'to_parking') {
      const slot = this._parkSlot(v);
      goals = slot ? new Set([key(slot.gx, slot.gy)]) : new Set();
    }

    // loading / dumping / parked → already at destination, no route to draw.
    if (!goals || !goals.size) return { path: [{ gx: v.gx, gy: v.gy }], goals: [] };

    const from = this._logical(v);
    const path = this._pathToward(from, goals, v) || [{ gx: from.gx, gy: from.gy }];
    const goalPts = [...goals].map((k) => { const [x, y] = k.split(','); return { gx: +x, gy: +y }; });
    return { path: path.map((c) => ({ gx: c.gx, gy: c.gy })), goals: goalPts };
  }
}

// ── World orchestrator ──────────────────────────────────────────────────────

function blockDistToParking(bx, by) {
  const dx = Math.max(PARK_BLOCKS.bx0 - bx, 0, bx - PARK_BLOCKS.bx1);
  const dy = Math.max(PARK_BLOCKS.by0 - by, 0, by - PARK_BLOCKS.by1);
  return Math.max(dx, dy);
}

// Place `n` crushers: the FIRST is guaranteed ~10 blocks from the parking (so a
// haul cycle is possible near the start); the rest are random, never on the
// parking (min 3 blocks away) and spread apart from each other (min 6 blocks).
function placeCrushers(n) {
  const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const out = [];

  // Mandatory crusher at ~10 blocks from the parking.
  const pcx = (PARK_BLOCKS.bx0 + PARK_BLOCKS.bx1) / 2;
  const pcy = (PARK_BLOCKS.by0 + PARK_BLOCKS.by1) / 2;
  for (let i = 0; i < 800; i++) {
    const ang = Math.random() * Math.PI * 2;
    const cbx = clamp(Math.round(pcx + Math.cos(ang) * 10), 0, COLS - 1);
    const cby = clamp(Math.round(pcy + Math.sin(ang) * 10), 0, ROWS - 1);
    const d = blockDistToParking(cbx, cby);
    if (d >= 9 && d <= 11) { out.push({ x: cbx * 2, y: cby * 2, w: 2, h: 2 }); break; }
  }
  if (!out.length) {
    const fbx = clamp(Math.round(pcx) + 10, 0, COLS - 1);
    const fby = clamp(Math.round(pcy), 0, ROWS - 1);
    out.push({ x: fbx * 2, y: fby * 2, w: 2, h: 2 });
  }

  // Fill the rest at random.
  let attempts = 0;
  while (out.length < n && attempts++ < 8000) {
    const cbx = randInt(0, COLS - 1);
    const cby = randInt(0, ROWS - 1);
    if (blockDistToParking(cbx, cby) < 3) continue;
    let clear = true;
    for (const c of out) {
      const ox = c.x / 2;
      const oy = c.y / 2;
      if (Math.max(Math.abs(cbx - ox), Math.abs(cby - oy)) < 6) { clear = false; break; }
    }
    if (!clear) continue;
    out.push({ x: cbx * 2, y: cby * 2, w: 2, h: 2 });
  }
  return out;
}

class World {
  constructor() {
    const zoneCols = COLS * 2;
    const zoneRows = ROWS * 2;
    this.grid = {
      zoneCols, zoneRows,
      zoneW: VIEW_W / zoneCols,
      zoneH: VIEW_H / zoneRows,
    };
    this.reset();
  }

  reset() {
    this.mine = generateMine(COLS, ROWS);
    this.credit = STARTING_CREDIT;
    this.crushers = placeCrushers(Math.ceil((COLS * ROWS) / BLOCKS_PER_CRUSHER));
    this.dirty = new Map();

    this.roads = new Roads(this.grid);
    this.roads.addParking(PARKING.x, PARKING.y, PARKING.w, PARKING.h);
    this.roads.setCrushers(this.crushers);

    const zone = Math.min(this.grid.zoneW, this.grid.zoneH);
    const mk = (o) => { const v = new Vehicle(o); v.place(this.grid); return v; };

    const lv  = mk({ type: 'pickup', label: 'LV01', gx: 6, gy: 8, len: zone * 0.95, wid: zone * 0.57 });
    const exca = (label, gx, gy, m) => mk({
      type: 'excavator', label, gx, gy,
      len: zone * 1.2 * m.scale, wid: zone * 0.95 * m.scale,
      model: m.model, bucket: m.bucket,
    });
    const hex1 = exca('HEX01', 12, 12, EXCAVATORS.R9400);
    const hex2 = exca('HEX02', 20, 16, EXCAVATORS.R9600);  // bigger reference model
    const hex3 = exca('HEX03', 28, 12, EXCAVATORS.R9400);
    const hex4 = exca('HEX04', 36, 16, EXCAVATORS.R9800);  // largest reference model
    const P = PARKING;
    const oht1 = mk({ type: 'oht', label: 'OHT01', gx: P.x + 1, gy: P.y, len: zone * 1.445, wid: zone * 0.7 });
    const oht2 = mk({ type: 'oht', label: 'OHT02', gx: P.x + 3, gy: P.y, len: zone * 1.445, wid: zone * 0.7 });
    const oht3 = mk({ type: 'oht', label: 'OHT03', gx: P.x + 5, gy: P.y, len: zone * 1.445, wid: zone * 0.7 });
    const oht4 = mk({ type: 'oht', label: 'OHT04', gx: P.x + 1, gy: P.y + 1, len: zone * 1.445, wid: zone * 0.7 });
    this.vehicles = [lv, hex1, hex2, hex3, hex4, oht1, oht2, oht3, oht4];
    this.byLabel = new Map(this.vehicles.map((v) => [v.label, v]));

    this.autopilot = new Autopilot(this.grid, this.roads, {
      getBlock: (bx, by) => this.mine.blocks[by]?.[bx],
      mineBlock: (bx, by, amount) => this._mineBlock(bx, by, amount),
      deliver: (ore, tons) => this._deliver(ore, tons),
    });
    this.autopilot.addShovel(hex1);
    this.autopilot.addShovel(hex2);
    this.autopilot.addShovel(hex3);
    this.autopilot.addShovel(hex4);
    this.autopilot.assign(oht1, hex1);
    this.autopilot.assign(oht2, hex1);
    this.autopilot.assign(oht3, hex2);
    this.autopilot.assign(oht4, hex2);
    this.autopilot.setEnabled(true);

    // Delta-broadcast baselines (last values sent to clients).
    this._lastVeh = new Map();
    this._lastCredit = null;
    this._debug = new Set();   // labels with debug-path visualisation enabled
  }

  // ── simulation tick ──
  tick(dt) {
    const isRoad = (gx, gy) => this.roads.isRoad(gx, gy);
    const isFree = (gx, gy, self) => this._isFree(gx, gy, self);
    this.autopilot.isFree = isFree;
    this.autopilot.update(dt);
    for (const v of this.vehicles) {
      let dir = null;
      if (v.manual && v.manualDir) dir = v.manualDir;
      else if (this.autopilot.controls(v)) dir = this.autopilot.dirFor(v);
      v.update(dt, dir, this.grid, isRoad, isFree);
    }
  }

  _isFree(gx, gy, self) {
    for (const v of this.vehicles) {
      if (v === self) continue;
      for (const c of v.occupiedCells(this.grid)) if (c.gx === gx && c.gy === gy) return false;
    }
    return true;
  }

  // ── gameplay hooks ──
  _markDirty(b) { this.dirty.set(`${b.x},${b.y}`, b); }

  _mineBlock(bx, by, amount) {
    const block = this.mine.blocks[by]?.[bx];
    if (!block || !block.explored) return 0;
    const want = Math.max(0, Math.floor(Number(amount) || 0));
    const mined = Math.min(want, block.oreRemaining);
    block.oreRemaining -= mined;
    this._markDirty(block);
    return mined;
  }

  _deliver(ore, tons) {
    const t = Math.max(0, Math.floor(Number(tons) || 0));
    const rate = ORE_VALUE[ore] || 0;
    this.credit += Math.round(rate * t);
  }

  // ── commands ──
  drill(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || x >= this.mine.cols || y < 0 || y >= this.mine.rows) {
      return { error: 'invalid coordinates', credit: this.credit };
    }
    const block = this.mine.blocks[y][x];
    if (block.explored) return { block, credit: this.credit };
    if (this.credit < DRILL_COST) return { error: 'insufficient credit', credit: this.credit };
    this.credit -= DRILL_COST;
    block.explored = true;
    this._markDirty(block);
    return { block, credit: this.credit };
  }

  setRoads(cells) {
    this.roads.setNetwork(cells);
    this.autopilot._bayCache = null;   // road change → recompute crusher bays
  }

  control(label, { dir, release } = {}) {
    const v = this.byLabel.get(label);
    if (!v) return;
    if (release) {
      // Deselecting hands any asset back to the autopilot — a shovel that was
      // driven manually resumes its automatic relocation once released.
      v.manual = false; v.manualDir = null;
      this.autopilot.clearManual(v);
      return;
    }
    v.manual = true;
    v.manualDir = Array.isArray(dir) ? dir : null;
    this.autopilot.setManual(v);
  }

  assign(truckLabel, shovelLabel) {
    const t = this.byLabel.get(truckLabel);
    if (!t || t.type !== 'oht') return;
    const s = shovelLabel ? this.byLabel.get(shovelLabel) : null;
    this.autopilot.assign(t, s || null);
  }

  // A client selected/deselected an asset — a selected shovel won't auto-relocate.
  select(label, on) {
    this.autopilot.setSelected(this.byLabel.get(label), on);
  }

  // ── shop ──
  // Buy and spawn an asset. Trucks/LV go onto the parking, shovels just beside
  // it. Returns { ok, credit, label } or { error, credit }.
  buyAsset(id) {
    const item = CATALOG.find((c) => c.id === id);
    if (!item) return { error: 'unknown', credit: this.credit };
    if (this.vehicles.length >= MAX_ASSETS) return { error: 'max', credit: this.credit };
    if (this.credit < item.price) return { error: 'credit', credit: this.credit };

    this.credit -= item.price;
    const zone = Math.min(this.grid.zoneW, this.grid.zoneH);
    const cell = this._spawnCell(item.type);
    let v;
    if (item.type === 'excavator') {
      const m = EXCAVATORS[id];
      v = new Vehicle({
        type: 'excavator', label: this._nextLabel('HEX'), gx: cell.gx, gy: cell.gy,
        len: zone * 1.2 * m.scale, wid: zone * 0.95 * m.scale, model: m.model, bucket: m.bucket,
      });
      this.autopilot.addShovel(v);
    } else if (item.type === 'oht') {
      v = new Vehicle({ type: 'oht', label: this._nextLabel('OHT'), gx: cell.gx, gy: cell.gy, len: zone * 1.445, wid: zone * 0.7 });
    } else {
      v = new Vehicle({ type: 'pickup', label: this._nextLabel('LV'), gx: cell.gx, gy: cell.gy, len: zone * 0.95, wid: zone * 0.57 });
    }
    v.place(this.grid);
    this.vehicles.push(v);
    this.byLabel.set(v.label, v);
    return { ok: true, credit: this.credit, label: v.label };
  }

  // Next free label for a prefix (OHT, HEX, LV) → e.g. "OHT05".
  _nextLabel(prefix) {
    let max = 0;
    for (const v of this.vehicles) {
      if (!v.label.startsWith(prefix)) continue;
      const n = parseInt(v.label.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return prefix + String(max + 1).padStart(2, '0');
  }

  // A free spawn cell: inside the parking for trucks/LV, just outside it for
  // shovels (scanning outward in rings).
  _spawnCell(type) {
    const P = PARKING;
    const occ = (gx, gy) => this.vehicles.some((v) => v.gx === gx && v.gy === gy);
    if (type === 'oht' || type === 'pickup') {
      for (let gy = P.y; gy < P.y + P.h; gy++)
        for (let gx = P.x; gx < P.x + P.w; gx++)
          if (!occ(gx, gy)) return { gx, gy };
    }
    const cx = P.x + Math.floor(P.w / 2);
    const cy = P.y + P.h + 1;
    for (let r = 0; r < 100; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter
          const gx = cx + dx;
          const gy = cy + dy;
          if (gx < 0 || gy < 0 || gx >= this.grid.zoneCols || gy >= this.grid.zoneRows) continue;
          if (!occ(gx, gy)) return { gx, gy };
        }
    }
    return { gx: P.x, gy: P.y };
  }

  // ── snapshots ──
  _publicBlock(b) { return b.explored ? b : { x: b.x, y: b.y, explored: false }; }

  _vehicle(v) {
    return {
      label: v.label, type: v.type, model: v.model,
      gx: v.gx, gy: v.gy, x: v.x, y: v.y, heading: v.heading,
      len: v.len, wid: v.wid,
      load: v.load, loadOre: v.loadOre, payload: v.payload, bucket: v.bucket,
      task: v.task, digging: v.digging, manual: v.manual,
      shovel: v.type === 'oht' ? (this.autopilot.assignedShovel(v)?.label ?? null) : null,
    };
  }

  fullState() {
    return {
      cols: this.mine.cols,
      rows: this.mine.rows,
      view: { w: VIEW_W, h: VIEW_H },
      blockTonnage: BLOCK_TONNAGE,
      credit: this.credit,
      drillCost: DRILL_COST,
      parking: PARKING,
      crushers: this.crushers,
      catalog: CATALOG,
      maxAssets: MAX_ASSETS,
      roads: this.roads.serialize(),
      vehicles: this.vehicles.map((v) => this._vehicle(v)),
      blocks: this.mine.blocks.map((row) => row.map((b) => this._publicBlock(b))),
    };
  }

  // Dynamic fields that may change tick to tick (rounded to cut float churn).
  _vehFields(v) {
    return {
      label: v.label,
      x: Math.round(v.x), y: Math.round(v.y),
      heading: Math.round(v.heading * 1000) / 1000,
      gx: v.gx, gy: v.gy,
      load: Math.round(v.load),
      loadOre: v.loadOre,
      task: v.task ? { kind: v.task.kind, progress: Math.round(v.task.progress * 100) / 100 } : null,
      digging: v.digging,
      manual: v.manual,
      shovel: v.type === 'oht' ? (this.autopilot.assignedShovel(v)?.label ?? null) : null,
    };
  }

  // Delta snapshot: only vehicles whose fields changed (and only those fields),
  // credit only if it changed, plus any blocks touched since last call. Returns
  // null when nothing changed at all, so the server can skip the frame entirely.
  liveDelta() {
    const vehicles = [];
    for (const v of this.vehicles) {
      const cur = this._vehFields(v);
      const prev = this._lastVeh.get(v.label);
      this._lastVeh.set(v.label, cur);
      if (!prev) { vehicles.push(cur); continue; } // first time → send all fields
      let d = null;
      for (const k in cur) {
        if (k === 'label') continue;
        if (!fieldEq(cur[k], prev[k])) (d ||= { label: cur.label })[k] = cur[k];
      }
      if (d) vehicles.push(d);
    }

    const blocks = [...this.dirty.values()].map((b) => this._publicBlock(b));
    this.dirty.clear();

    const creditChanged = this.credit !== this._lastCredit;
    this._lastCredit = this.credit;

    if (!vehicles.length && !blocks.length && !creditChanged) return null;
    const msg = { vehicles, blocks };
    if (creditChanged) msg.credit = this.credit;
    return msg;
  }

  // ── debug-path visualisation ──
  setDebug(label, on) {
    if (on) this._debug.add(label);
    else this._debug.delete(label);
  }
  hasDebug() { return this._debug.size > 0; }

  // { [label]: { path:[{gx,gy}], goals:[{gx,gy}] } } for every debug-enabled asset.
  debugPaths() {
    const out = {};
    for (const label of this._debug) {
      const v = this.byLabel.get(label);
      if (!v) continue;
      const plan = this.autopilot.debugPlan(v);
      if (plan) out[label] = plan;
    }
    return out;
  }
}

// Equality for delta fields — scalars by ===, the task object by its contents.
function fieldEq(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return a.kind === b.kind && a.progress === b.progress;
  return false;
}

module.exports = { World, VIEW_W, VIEW_H, COLS, ROWS, DRILL_COST };
