// Authoritative server-side world. ALL gameplay state lives here and is advanced
// by tick(dt): vehicle movement, anti-collision, the haul autopilot, shovel
// relocation, loading/unloading, payouts. The client only renders snapshots and
// sends commands (drill, edit roads, drive manually, assign, reset).

const { generateMine, setOre, BLOCK_TONNAGE } = require('./mine');

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
// Parked trucks all face up (nose toward -y), lined up "en bataille".
const PARK_HEADING = -Math.PI / 2;
const PARK_BLOCKS = {
  bx0: Math.floor(PARKING.x / 2),
  by0: Math.floor(PARKING.y / 2),
  bx1: Math.floor((PARKING.x + PARKING.w - 1) / 2),
  by1: Math.floor((PARKING.y + PARKING.h - 1) / 2),
};

// ── Vehicle ─────────────────────────────────────────────────────────────────

const BASE_SPEED = 168; // px/s

// Collision footprint multiplier for haul trucks. Their real body is ~1.45 cells
// long, which under the cell-reservation rule (any cell the body's AABB clips is
// reserved) makes a horizontal truck occupy 3 cells and forces ~3-cell following
// gaps. Shrinking the *collision* footprint (not the sprite) to its centre cell
// lets trucks tuck right up behind one another; the tiny sprite overlap when
// bumper-to-bumper is the accepted trade-off for a tighter convoy.
const TRUCK_COLLISION_SCALE = 0.66;

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
    // The cell physically left on the current/last move — used by the autopilot
    // to forbid immediate U-turns (anti-oscillation).
    this.fromGx = gx; this.fromGy = gy;
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
    // Autopilot may steer this vehicle off the road (truck docking to a shovel).
    this.offroad = false;
    // Collision footprint multiplier (see TRUCK_COLLISION_SCALE). 1 = full body.
    this.collisionScale = type === 'oht' ? TRUCK_COLLISION_SCALE : 1;
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
      const onRoad = !this.roadOnly || this.manual || this.offroad || (isRoad && isRoad(nx, ny));
      const cells = this.collisionCells(nx, ny, grid, this.heading);
      const free = !isFree || cells.every((c) => isFree(c.gx, c.gy, this));
      if (inBounds && onRoad && free) {
        this.fromGx = this.gx; this.fromGy = this.gy;
        this.tgx = nx; this.tgy = ny;
        this.moving = true;
      }
    }
  }

  // Every grid cell the vehicle's graphic footprint overlaps when centred on cell
  // (gx,gy): the axis-aligned bounds of its (len × wid) body rotated by `heading`.
  // Collision reserves exactly these cells, so two vehicles never share one — and
  // therefore their sprites never overlap.
  footprintAt(gx, gy, grid, heading = this.heading, scale = 1) {
    const c = Math.abs(Math.cos(heading));
    const s = Math.abs(Math.sin(heading));
    const len = this.len * scale, wid = this.wid * scale;
    const hx = (c * len + s * wid) / 2;   // half-extents of the AABB (px)
    const hy = (s * len + c * wid) / 2;
    const cx = (gx + 0.5) * grid.zoneW;
    const cy = (gy + 0.5) * grid.zoneH;
    const x0 = Math.floor((cx - hx) / grid.zoneW);
    const x1 = Math.ceil((cx + hx) / grid.zoneW) - 1;
    const y0 = Math.floor((cy - hy) / grid.zoneH);
    const y1 = Math.ceil((cy + hy) / grid.zoneH) - 1;
    const cells = [];
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) cells.push({ gx: xx, gy: yy });
    return cells;
  }

  // Cells this vehicle's collision reserves when centred on (gx,gy) facing
  // `heading`: its (possibly shrunk) body footprint, plus — for haul trucks — the
  // single cell directly BEHIND it. The rear cell forces a follower to leave a
  // body-length gap (so two truck sprites never touch) while keeping the cell
  // AHEAD free, so a truck can still pull right up against a shovel or crusher.
  collisionCells(gx, gy, grid, heading = this.heading) {
    const s = this.collisionScale;
    const cells = this.footprintAt(gx, gy, grid, heading, s);
    if (this.type === 'oht') {
      const bx = -Math.round(Math.cos(heading));
      const by = -Math.round(Math.sin(heading));
      for (const c of this.footprintAt(gx + bx, gy + by, grid, heading, s)) cells.push(c);
    }
    return cells;
  }

  occupiedCells(grid) {
    const cells = this.collisionCells(this.gx, this.gy, grid, this.heading);
    if (this.moving) for (const c of this.collisionCells(this.tgx, this.tgy, grid, this.heading)) cells.push(c);
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

// Anti-jam timers (in ticks). When a truck cannot make forward progress because
// another vehicle blocks the shortest step, it waits a few ticks, then is allowed
// to take a longer sideways detour, and finally (deadlock) to reverse one cell to
// yield. Thresholds keep this from degenerating into back-and-forth jitter.
const STUCK_DETOUR = 5;           // ticks a truck waits for a blocked shortest step before detouring
const DIST_CACHE_MAX = 64;        // cap distinct cached distance fields

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
    this._distCache = new Map();     // goal-set id → distance field (cleared on road change)
    this._rank = new Map();          // truck → stable priority (first-seen order)
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
    v.offroad = false;
  }

  clearManual(v) {
    if (!this._manual.has(v)) return;
    this._manual.delete(v);
    const st = this.state.get(v);
    if (st) { st.phase = v.load > 0 ? 'to_crusher' : 'to_shovel'; st.dir = null; st.timer = 0; st.stuck = 0; st.yield = null; }
  }

  isManual(v) { return this._manual.has(v); }

  assign(truck, shovel) {
    this._freeLocks(truck);
    truck.offroad = false;
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
    // Resolve head-on deadlocks once every truck has picked a direction.
    const dirOf = new Map();
    for (const [truck, st] of this.state) dirOf.set(truck, st.dir);
    this._resolveDeadlocks(dirOf);
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
      // Otherwise relocate to the best EXPLORED ore block within 3 blocks, onto a
      // sub-zone where the shovel's body clears every surrounding road.
      const next = this._bestOreInRadius(shovel, bx, by, 3);
      if (next) this._shovelMove.set(shovel, next.place);
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

  // True when the shovel's whole graphic footprint, centred on cell (gx,gy), stays
  // in bounds and clears every road cell — so it never parks straddling a road.
  _footprintRoadFree(shovel, gx, gy) {
    for (const c of shovel.footprintAt(gx, gy, this.grid)) {
      if (c.gx < 0 || c.gy < 0 || c.gx >= this.grid.zoneCols || c.gy >= this.grid.zoneRows) return false;
      if (this.roads.isRoad(c.gx, c.gy)) return false;
    }
    return true;
  }

  // A sub-zone of block (bx,by) where the shovel can sit without its body
  // overlapping any road. Prefers the cell matching its current parity. Null if
  // every sub-zone would straddle a road. Returns { gx, gy }.
  _shovelPlacement(shovel, bx, by) {
    const xs = (shovel.gx % 2) === 0 ? [0, 1] : [1, 0];
    const ys = (shovel.gy % 2) === 0 ? [0, 1] : [1, 0];
    for (const oy of ys)
      for (const ox of xs) {
        const gx = bx * 2 + ox;
        const gy = by * 2 + oy;
        if (this._footprintRoadFree(shovel, gx, gy)) return { gx, gy };
      }
    return null;
  }

  // Best EXPLORED ore block within `R` blocks (Chebyshev) of (bx,by) for `shovel`
  // to move to. Never reveals undrilled ground, never a block on a road, and only
  // blocks where a road-clear placement exists for this shovel's body. Priority:
  // road access first, then nearest, then richest. Returns { bx, by, place } | null.
  _bestOreInRadius(shovel, bx, by, R) {
    let best = null;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nbx = bx + dx;
        const nby = by + dy;
        const b = this.hooks.getBlock(nbx, nby);
        if (!(b && b.explored && b.ore && b.oreRemaining > 0)) continue;
        if (this._blockOnRoad(nbx, nby)) continue;       // never sit on a road
        const place = this._shovelPlacement(shovel, nbx, nby);
        if (!place) continue;                            // body would straddle a road
        const hasRoad = this._bayCells(nbx * 2, nby * 2, nbx * 2 + 1, nby * 2 + 1).size > 0;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const cand = { bx: nbx, by: nby, ore: b.oreRemaining, hasRoad, dist, place };
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
    this.state.set(truck, { phase: 'to_shovel', dir: null, timer: 0, bucket: 0, stuck: 0, want: null, yield: null });
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
    st.want = null;   // recomputed by _advance; cleared so the resolver ignores idle trucks
    if (this._manual.has(truck)) { st.dir = null; st.yield = null; return; }
    if (st.yield) { st.dir = this._yieldStep(truck, st); return; }
    const sb = this._shovelBlock(shovel);

    // A road-travel phase assumes the truck is on the network. If it isn't (e.g.
    // the player released it mid-dock), walk it back to the nearest road first —
    // the road autopilot can't route from an off-road cell.
    const roadPhase = st.phase === 'to_shovel' || st.phase === 'to_crusher' || st.phase === 'to_parking';
    if (roadPhase && !this.roads.isRoad(truck.gx, truck.gy) && !truck.moving) {
      truck.offroad = true;
      const target = this._nearestRoadCell(truck);
      st.dir = target ? this._offroadStep(truck, target) : null;
      return;
    }

    switch (st.phase) {
      case 'loading':    st.dir = null; shovel.digging = true; this._doLoad(dt, truck, shovel, sb, st); return;
      case 'docking':    this._tickDocking(truck, shovel, sb, st); return;
      case 'undocking':  this._tickUndocking(truck, st); return;
      case 'dumping':    st.dir = null; this._doDump(dt, truck, st); return;
      case 'parked':     truck.offroad = false; this._tickParked(dt, truck, shovel, sb, st); return;
      case 'to_shovel':  truck.offroad = false; this._tickToShovel(truck, shovel, sb, st); return;
      case 'to_crusher': truck.offroad = false; this._tickToCrusher(truck, st); return;
      case 'to_parking': truck.offroad = false; this._tickToParking(truck, st); return;
      default:           truck.offroad = false; st.phase = 'to_shovel'; st.dir = null; return;
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
    const from = this._logical(truck);
    // Prefer loading from a road cell that already TOUCHES the shovel body (and is
    // reachable with the road flow). Only when no such road cell exists do we aim
    // at the looser block-level goals and finish off-road. A settled shovel only —
    // a relocating one has a transient body position.
    let goals, gid;
    const settled = !this._shovelMove.has(shovel) && !shovel.moving;
    const roadBays = settled ? this._shovelRoadBays(shovel) : new Set();
    if (roadBays.size && this._reachStatic(from, roadBays, `SR:${shovel.gx},${shovel.gy}`)) {
      goals = roadBays; gid = `SR:${shovel.gx},${shovel.gy}`;
    } else {
      goals = this._shovelGoals(sb); gid = `S:${sb.bx},${sb.by}`;
    }
    if (!goals.size || !this._reachStatic(from, goals, gid)) {
      st.phase = truck.load > 0 ? 'to_crusher' : 'to_parking';
      st.dir = null; return;
    }
    const a = this._advance(truck, goals, gid, () => this._canTakeShovel(shovel, truck));
    if (a.arrived) {
      // Claim the shovel. If we already sit in a cell touching it (an adjacent
      // road cell), load right here. Otherwise leave the road and nuzzle into the
      // sub-cell next to the shovel; the arrival cell is where we rejoin the road.
      if (this._tryLockShovel(shovel, truck)) {
        const lc = this._logical(truck);
        st.road = { gx: lc.gx, gy: lc.gy }; st.timer = 0; st.bucket = 0; truck.load = 0;
        st.phase = this._adjacentToShovel(truck, shovel) ? 'loading' : 'docking';
      }
      st.dir = null; return;
    }
    st.dir = a.dir;
  }

  // Road cells orthogonally touching the shovel's body — the preferred (on-road)
  // loading positions, so a truck need not leave the network when one is reachable.
  _shovelRoadBays(shovel) {
    const occ = new Set(shovel.footprintAt(shovel.gx, shovel.gy, this.grid).map((c) => key(c.gx, c.gy)));
    const set = new Set();
    for (const cstr of occ) {
      const [gx, gy] = cstr.split(',').map(Number);
      for (const [dx, dy] of DIRS) {
        const nx = gx + dx, ny = gy + dy;
        if (occ.has(key(nx, ny))) continue;
        const c = this.roads.cells.get(key(nx, ny));
        if (c && !c.parking) set.add(key(nx, ny));
      }
    }
    return set;
  }

  // Off-road approach: drive the truck from the road cell it arrived on into a
  // free sub-cell orthogonally touching the shovel's body, then start loading.
  // Aborts back to the road if the block runs out of ore before we get there.
  _tickDocking(truck, shovel, sb, st) {
    truck.task = null;
    truck.offroad = true;
    const block = this.hooks.getBlock(sb.bx, sb.by);
    if (!block || !block.explored || !block.ore || block.oreRemaining <= 0) {
      this._unlockShovel(shovel, truck);
      st.phase = 'undocking'; st.undockThen = truck.load > 0 ? 'to_crusher' : 'to_parking'; st.dir = null; return;
    }
    if (!truck.moving && this._adjacentToShovel(truck, shovel)) {
      st.phase = 'loading'; st.timer = 0; st.bucket = 0; truck.load = 0; st.dir = null; return;
    }
    const bay = this._shovelDockBay(truck, shovel);
    st.dir = bay ? this._offroadStep(truck, bay) : null;
  }

  // Off-road return: drive the truck back to the road cell it docked from (or any
  // road cell), then hand control back to the normal road autopilot.
  _tickUndocking(truck, st) {
    truck.task = null;
    truck.offroad = true;
    const lc = this._logical(truck);
    if (!truck.moving && this.roads.isRoad(lc.gx, lc.gy)) {
      truck.offroad = false;
      st.phase = st.undockThen || 'to_crusher'; st.dir = null; st.stuck = 0;
      return;
    }
    const target = st.road || this._nearestRoadCell(truck) || lc;
    st.dir = this._offroadStep(truck, target);
  }

  // True when any cell of the shovel's body is orthogonally adjacent to the
  // truck's current cell — i.e. the truck is parked right against the shovel.
  _adjacentToShovel(truck, shovel) {
    const a = this._logical(truck);
    const occ = new Set(shovel.footprintAt(shovel.gx, shovel.gy, this.grid).map((c) => key(c.gx, c.gy)));
    for (const [dx, dy] of DIRS) if (occ.has(key(a.gx + dx, a.gy + dy))) return true;
    return false;
  }

  // Nearest free sub-cell orthogonally touching the shovel's body that the truck
  // can occupy — the docking target. Null if the shovel is fully boxed in.
  _shovelDockBay(truck, shovel) {
    const occ = new Set(shovel.footprintAt(shovel.gx, shovel.gy, this.grid).map((c) => key(c.gx, c.gy)));
    const a = this._logical(truck);
    let best = null, bestD = Infinity;
    for (const cstr of occ) {
      const [gx, gy] = cstr.split(',').map(Number);
      for (const [dx, dy] of DIRS) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
        if (occ.has(key(nx, ny))) continue;
        if (!this._canOccupy(truck, nx, ny, -dx, -dy)) continue;   // free, facing the shovel
        const d = Math.abs(a.gx - nx) + Math.abs(a.gy - ny);
        if (d < bestD) { bestD = d; best = { gx: nx, gy: ny }; }
      }
    }
    return best;
  }

  // One orthogonal off-road step that strictly reduces Manhattan distance to
  // `target`. Monotonic by construction, so it always terminates and can never
  // oscillate. Null when already there or every reducing step is blocked (wait).
  _offroadStep(truck, target) {
    const a = this._logical(truck);
    let best = null, bestD = Math.abs(target.gx - a.gx) + Math.abs(target.gy - a.gy);
    if (bestD === 0) return null;
    for (const [dx, dy] of DIRS) {
      const nx = a.gx + dx, ny = a.gy + dy;
      if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
      const d = Math.abs(target.gx - nx) + Math.abs(target.gy - ny);
      if (d < bestD && this._canOccupy(truck, nx, ny, dx, dy)) { bestD = d; best = [dx, dy]; }
    }
    return best;
  }

  // Closest free road cell to the truck (expanding ring), used as a fallback
  // undock target if the docking road cell was lost.
  _nearestRoadCell(truck) {
    const a = this._logical(truck);
    for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = a.gx + dx, gy = a.gy + dy;
          if (!this.roads.isRoad(gx, gy)) continue;
          if (this._canOccupy(truck, gx, gy, 0, 0)) return { gx, gy };
        }
    }
    return null;
  }

  _tickToCrusher(truck, st) {
    truck.task = null;
    const bays = this._crusherBays();           // cell key → crusher index
    if (!bays.size) { st.phase = 'to_parking'; st.dir = null; return; }
    const goals = new Set(bays.keys());
    const from = this._logical(truck);
    if (!this._reachStatic(from, goals, 'C')) { st.phase = 'to_parking'; st.dir = null; return; }
    // The field heads to the NEAREST crusher bay; the gate prevents claiming a bay
    // whose crusher is busy.
    const a = this._advance(truck, goals, 'C', (nx, ny) => {
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
    const a = this._advance(truck, goals, `P:${slot.gx},${slot.gy}`, null);
    if (a.arrived) { st.phase = 'parked'; st.timer = 0; st.dir = null; truck.heading = PARK_HEADING; return; }
    st.dir = a.dir;
  }

  // If the truck can do something useful right now, switch its phase and return
  // true. Loaded → deliver at the crusher; empty → fetch ore from its shovel.
  // Reachability ignores other vehicles so a momentary jam never blocks a redirect.
  _redirectIfUseful(truck, st) {
    const from = this._logical(truck);
    if (truck.load > 0) {
      if (this._reachStatic(from, this._crusherGoals(), 'C')) {
        this._releaseSlot(truck); st.phase = 'to_crusher'; st.dir = null; st.stuck = 0; return true;
      }
      return false;
    }
    const shovel = this.links.get(truck);
    if (!shovel) return false;
    const sb = this._shovelBlock(shovel);
    const block = this.hooks.getBlock(sb.bx, sb.by);
    const hasOre = block && block.explored && block.ore && block.oreRemaining > 0;
    if (hasOre && this._reachStatic(from, this._shovelGoals(sb), `S:${sb.bx},${sb.by}`)) {
      this._releaseSlot(truck); st.phase = 'to_shovel'; st.dir = null; st.stuck = 0; return true;
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
        st.phase = 'undocking'; st.undockThen = truck.load > 0 ? 'to_crusher' : 'to_parking';
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
      st.phase = 'undocking'; st.undockThen = 'to_crusher'; st.timer = 0; st.bucket = 0;
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

  // Can `truck` sit centred on cell (gx,gy) heading (dx,dy) without its footprint
  // overlapping another vehicle? Mirrors the check Vehicle.update does for the
  // real move, so the autopilot doesn't keep ordering moves that get rejected.
  _canOccupy(truck, gx, gy, dx, dy) {
    if (!this.isFree) return true;
    const heading = (dx || dy) ? Math.atan2(dy, dx) : truck.heading;
    for (const c of truck.collisionCells(gx, gy, this.grid, heading)) {
      if (!this.isFree(c.gx, c.gy, truck)) return false;
    }
    return true;
  }

  // Stable priority (first-seen order). Used to decide who yields in a head-on.
  _rankOf(truck) {
    let r = this._rank.get(truck);
    if (r == null) { r = this._rank.size; this._rank.set(truck, r); }
    return r;
  }

  // Step one cell toward `goals` along the cached distance field (shortest path,
  // re-evaluated every tick). Greedy descent: move to the free forward neighbour
  // with the lowest remaining distance. We never step backward in normal flow,
  // which is what eliminates the back-and-forth jitter; if the shortest step is
  // blocked by another vehicle we wait a few ticks, then take a longer free detour
  // when the network offers one. Genuine head-on deadlocks are broken separately
  // by `_resolveDeadlocks`. One-way flow is enforced by `_neighbors`; `gate` may
  // veto the final step into a goal cell. Records the intended forward cell in
  // `st.want` (even when blocked) so the deadlock resolver can see the intent.
  _advance(truck, goals, id, gate) {
    const st = this.state.get(truck);
    if (st) st.want = null;
    const lc = this._logical(truck);
    const lck = key(lc.gx, lc.gy);
    if (goals.has(lck)) { if (st) st.stuck = 0; return { arrived: !truck.moving, dir: null }; }

    const field = this._distField(goals, id);
    const dC = field.get(lck);
    if (dC == null) { if (st) st.stuck = 0; return { arrived: false, dir: null }; } // unreachable

    const gateOk = (n) => !(goals.has(key(n.gx, n.gy)) && gate && !gate(n.gx, n.gy));

    let want = null, wantD = Infinity;       // closest forward neighbour (free or not)
    let prog = null, progD = Infinity;       // free, strictly closer
    let lane = null;                         // free, equal-distance parallel lane (overtake)
    let detour = null, detourD = Infinity;   // free, longer way round, not a U-turn
    for (const n of this._neighbors(lc)) {
      const dn = field.get(key(n.gx, n.gy));
      if (dn == null || !gateOk(n)) continue;
      if (dn < dC && dn < wantD) { wantD = dn; want = n; }
      if (!this._canOccupy(truck, n.gx, n.gy, n.gx - lc.gx, n.gy - lc.gy)) continue;
      const back = n.gx === truck.fromGx && n.gy === truck.fromGy;
      if (dn < dC) { if (dn < progD) { progD = dn; prog = n; } }
      else if (back) continue;
      else if (dn === dC) { if (!lane) lane = n; }              // sideways onto an equal lane
      else if (dn < detourD) { detourD = dn; detour = n; }       // a strictly longer reroute
    }
    if (st) st.want = want;   // where we'd go if unobstructed (for the resolver)

    // Prefer real progress; if the lane ahead is blocked, change lane at once to
    // overtake (an equal-distance parallel lane = the next carriageway lane), and
    // only fall back to a longer detour after waiting a beat.
    let pick = prog || lane;
    if (!pick && st && st.stuck >= STUCK_DETOUR) pick = detour;
    if (pick) {
      if (st) st.stuck = 0;
      return { arrived: false, dir: [pick.gx - lc.gx, pick.gy - lc.gy] };
    }
    if (st && !truck.moving) st.stuck++;   // only count real waiting, not in-transit ticks
    return { arrived: false, dir: null };
  }

  // Detect head-on deadlocks after every truck has chosen a direction this tick.
  // A deadlock is a pair of stationary trucks that each want to move into the
  // other's cell (a mutual swap) on a one-lane stretch. The lower-priority truck
  // enters a committed "yield": it clears the lane (tucks into a side pocket, or
  // retreats ahead of the oncoming truck until it finds one) and holds there until
  // the other truck has passed, then resumes. This fires ONLY on a true mutual
  // swap, so ordinary queues (trucks following one another) are never disturbed.
  _resolveDeadlocks(dirOf) {
    const at = new Map();   // logical cell key → stationary truck
    for (const [truck] of this.state) {
      if (truck.moving || !this.links.has(truck)) continue;
      at.set(key(truck.gx, truck.gy), truck);
    }
    for (const [truck, st] of this.state) {
      if (st.yield || dirOf.get(truck) || !st.want) continue;  // already yielding/moving/idle
      const other = at.get(key(st.want.gx, st.want.gy));
      if (!other) continue;                                    // blocker isn't a stopped truck
      const ost = this.state.get(other);
      if (!ost || !ost.want) continue;
      const swap = ost.want.gx === truck.gx && ost.want.gy === truck.gy;
      if (!swap || this._rankOf(truck) > this._rankOf(other)) continue; // higher rank holds
      st.yield = { to: other, axis: [st.want.gx - truck.gx, st.want.gy - truck.gy], parked: false };
      st.dir = this._yieldStep(truck, st);
    }
  }

  // Drive a truck that is yielding to an oncoming truck (see `_resolveDeadlocks`).
  // Monotonic by construction — it only moves AWAY from the goal (sideways into a
  // pocket, else one cell back along the conflict axis) and never re-advances until
  // the other truck has passed, so it can never produce back-and-forth jitter.
  _yieldStep(truck, st) {
    const y = st.yield;
    const a = this._logical(truck);
    const bl = this._logical(y.to);
    const proj = (bl.gx - a.gx) * y.axis[0] + (bl.gy - a.gy) * y.axis[1];
    const adjacent = Math.abs(bl.gx - a.gx) + Math.abs(bl.gy - a.gy) <= 1;
    if (proj < 0 || (!adjacent && proj === 0)) { st.yield = null; st.stuck = 0; return null; } // passed → resume
    if (truck.moving) return st.dir;          // finish the current hop
    if (y.parked) return null;                // tucked aside → hold until it passes
    let pocket = null, back = null;
    for (const n of this._neighbors(a)) {
      if (this.isFree && !this.isFree(n.gx, n.gy, truck)) continue;
      const along = (n.gx - a.gx) * y.axis[0] + (n.gy - a.gy) * y.axis[1];
      if (along === 0) pocket = n;            // off-axis escape
      else if (along < 0) back = n;           // one cell back, away from the oncoming truck
    }
    if (pocket) { y.parked = true; return [pocket.gx - a.gx, pocket.gy - a.gy]; }
    if (back) return [back.gx - a.gx, back.gy - a.gy];
    return null;                              // boxed in — wait
  }

  // Cells from which a truck can be loaded: any road cell on the shovel's block
  // or on a block adjacent to it (Chebyshev distance ≤ 1 block). A truck only has
  // to reach the same or a neighbouring block — it needn't sit in a specific bay.
  _shovelGoals(sb) {
    const set = new Set();
    const x0 = (sb.bx - 1) * 2, x1 = (sb.bx + 1) * 2 + 1;
    const y0 = (sb.by - 1) * 2, y1 = (sb.by + 1) * 2 + 1;
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++) {
        const c = this.roads.cells.get(key(gx, gy));
        if (c && !c.parking) set.add(key(gx, gy));
      }
    return set;
  }

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

  // Road cells orthogonally adjacent to the block rectangle [x0..x1]×[y0..y1]
  // (the "bays" a truck can sit in to load/dump). Probes only the perimeter ring
  // instead of scanning the whole road network.
  _bayCells(x0, y0, x1, y1) {
    const set = new Set();
    const add = (gx, gy) => {
      const c = this.roads.cells.get(key(gx, gy));
      if (c && !c.parking) set.add(key(gx, gy));
    };
    for (let gx = x0; gx <= x1; gx++) { add(gx, y0 - 1); add(gx, y1 + 1); }
    for (let gy = y0; gy <= y1; gy++) { add(x0 - 1, gy); add(x1 + 1, gy); }
    return set;
  }

  _buildSlots() {
    this._slots = [];
    this._slotByTruck = new Map();
    // "En bataille" grid: nose-up trucks one column apart (their narrow side) and
    // two rows apart (so a truck's body + rear cell clears the row in front),
    // filling the pad in tidy aligned ranks.
    for (const p of this.roads.parkings || [])
      for (let gy = p.y; gy <= p.y + p.h - 1; gy += 2)
        for (let gx = p.x; gx < p.x + p.w; gx++)
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

  // Distance field: shortest road distance (respecting one-way flow) from every
  // cell that can legally reach `goals`. Built by a reverse BFS from the goal
  // cells — for each known cell B we admit a predecessor A iff A→B is a legal
  // move (A is road, and B is not entered against its arrow). Vehicle-independent,
  // so it depends only on the road network and the goal set: cached by `id` and
  // invalidated wholesale when roads change. The greedy descent in `_advance`
  // handles transient vehicle obstacles, so the field never needs rebuilding for
  // them — this is the bulk of the CPU saving over per-truck BFS.
  _distField(goals, id) {
    if (id != null) { const hit = this._distCache.get(id); if (hit) return hit; }
    const dist = new Map();
    const queue = [];
    for (const gk of goals) {
      const [gx, gy] = gk.split(',');
      dist.set(gk, 0);
      queue.push({ gx: +gx, gy: +gy });
    }
    for (let head = 0; head < queue.length; head++) {
      const b = queue[head];
      const dB = dist.get(key(b.gx, b.gy));
      const bCell = this.roads.cells.get(key(b.gx, b.gy));
      const bDir = (bCell && !bCell.parking) ? bCell.dir : null;
      for (const [dx, dy] of DIRS) {
        const ax = b.gx - dx, ay = b.gy - dy;   // predecessor A; the move A→B is (dx,dy)
        if (ax < 0 || ay < 0 || ax >= this.grid.zoneCols || ay >= this.grid.zoneRows) continue;
        const ak = key(ax, ay);
        if (dist.has(ak)) continue;
        if (!this.roads.isRoad(ax, ay)) continue;
        if (bDir && dx === -bDir.dx && dy === -bDir.dy) continue; // can't enter B against its flow
        dist.set(ak, dB + 1);
        queue.push({ gx: ax, gy: ay });
      }
    }
    if (id != null) {
      if (this._distCache.size >= DIST_CACHE_MAX) this._distCache.clear();
      this._distCache.set(id, dist);
    }
    return dist;
  }

  _reachStatic(from, goals, id) {
    if (!goals || !goals.size) return false;
    if (!this.roads.isRoad(from.gx, from.gy)) return false;
    return this._distField(goals, id).get(key(from.gx, from.gy)) != null;
  }

  // Greedy shortest-path reconstruction along the field, for debug visualisation.
  _fieldPath(from, goals, id) {
    const field = this._distField(goals, id);
    let cur = { gx: from.gx, gy: from.gy };
    if (field.get(key(cur.gx, cur.gy)) == null) return null;
    const path = [cur];
    const seen = new Set([key(cur.gx, cur.gy)]);
    while (!goals.has(key(cur.gx, cur.gy))) {
      const dC = field.get(key(cur.gx, cur.gy));
      let next = null, nd = Infinity;
      for (const n of this._neighbors(cur)) {
        const d = field.get(key(n.gx, n.gy));
        if (d != null && d < dC && d < nd && !seen.has(key(n.gx, n.gy))) { nd = d; next = n; }
      }
      if (!next) break;
      seen.add(key(next.gx, next.gy)); path.push(next); cur = next;
    }
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
    let gid = null;
    if (st.phase === 'to_shovel') {
      const s = this.links.get(v);
      if (s) { const sb = this._shovelBlock(s); goals = this._shovelGoals(sb); gid = `S:${sb.bx},${sb.by}`; }
    } else if (st.phase === 'to_crusher') {
      goals = this._crusherGoals(); gid = 'C';
    } else if (st.phase === 'to_parking') {
      const slot = this._parkSlot(v);
      if (slot) { goals = new Set([key(slot.gx, slot.gy)]); gid = `P:${slot.gx},${slot.gy}`; }
      else goals = new Set();
    }

    // loading / dumping / parked → already at destination, no route to draw.
    if (!goals || !goals.size) return { path: [{ gx: v.gx, gy: v.gy }], goals: [] };

    const from = this._logical(v);
    const path = this._fieldPath(from, goals, gid) || [{ gx: from.gx, gy: from.gy }];
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
    this.dirty = new Map();

    this.roads = new Roads(this.grid);
    // Parking sized to hold the default haul-truck fleet with ≥50% free margin.
    const park = this._sizedParkingRect(4);
    this.roads.addParking(park.x, park.y, park.w, park.h);

    this.crushers = placeCrushers(Math.ceil((COLS * ROWS) / BLOCKS_PER_CRUSHER));
    // A random demo circuit: a one-way loop out of the parking, past a crusher,
    // with unrevealed ore seeded alongside it — different every game.
    const circuit = this._buildExampleCircuit(park);
    if (circuit) this.crushers[0] = circuit.crusher;     // put a crusher on the loop
    this.roads.setCrushers(this.crushers);
    if (circuit) this.roads.setNetwork(circuit.cells);   // pre-draw the example road

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
    const oht1 = mk({ type: 'oht', label: 'OHT01', gx: park.x, gy: park.y, len: zone * 1.445, wid: zone * 0.7 });
    const oht2 = mk({ type: 'oht', label: 'OHT02', gx: park.x, gy: park.y, len: zone * 1.445, wid: zone * 0.7 });
    const oht3 = mk({ type: 'oht', label: 'OHT03', gx: park.x, gy: park.y, len: zone * 1.445, wid: zone * 0.7 });
    const oht4 = mk({ type: 'oht', label: 'OHT04', gx: park.x, gy: park.y, len: zone * 1.445, wid: zone * 0.7 });
    this.vehicles = [lv, hex1, hex2, hex3, hex4, oht1, oht2, oht3, oht4];
    this.byLabel = new Map(this.vehicles.map((v) => [v.label, v]));
    this._placeTrucksInParking([oht1, oht2, oht3, oht4]);   // line them up "en bataille"

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

  // Smallest parking rectangle (anchored at PARKING) whose "en bataille" slot
  // grid holds `n` trucks plus ≥50% spare capacity. Grows columns first, then
  // rows, never below the default pad. `_buildSlots` lays slots at every column
  // and every other row, so capacity = w · ceil(h/2).
  _sizedParkingRect(n) {
    const needed = Math.ceil(n * 1.5);
    let { x, y, w, h } = PARKING;
    const capacity = () => w * Math.ceil(h / 2);
    let guard = 0;
    while (capacity() < needed && guard++ < 200) {
      if (w < 10 && w + x < this.grid.zoneCols - 1) w += 1;
      else if (h + y < this.grid.zoneRows - 1) h += 2;
      else break;
    }
    return { x, y, w, h };
  }

  // Line the trucks up nose-up on the parking's slot grid, left-to-right / top-to-
  // bottom — so the default fleet starts neatly "en bataille".
  _placeTrucksInParking(trucks) {
    const slots = [];
    for (const p of this.roads.parkings)
      for (let gy = p.y; gy <= p.y + p.h - 1; gy += 2)
        for (let gx = p.x; gx < p.x + p.w; gx++) slots.push({ gx, gy });
    trucks.forEach((t, i) => {
      const s = slots[Math.min(i, slots.length - 1)] || { gx: PARKING.x, gy: PARKING.y };
      t.gx = s.gx; t.gy = s.gy; t.tgx = s.gx; t.tgy = s.gy; t.fromGx = s.gx; t.fromGy = s.gy;
      t.moving = false; t.heading = PARK_HEADING; t.place(this.grid);
    });
  }

  // A random demonstration circuit: a one-way rectangular loop hanging off the
  // bottom of the parking (so trucks can enter and leave it), with a crusher on
  // its lower edge and a little unrevealed ore seeded just inside, near the
  // crusher. Returns { cells, crusher } or null if the map is too small.
  _buildExampleCircuit(park) {
    const { zoneCols, zoneRows } = this.grid;
    const ri = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

    const left = park.x;
    const top = park.y + park.h;                 // first row just below the parking
    const maxW = zoneCols - left - 3;
    const maxH = zoneRows - top - 4;
    if (maxW < 10 || maxH < 10) return null;
    const w = Math.min(maxW, ri(Math.max(park.w + 2, 14), 26));
    const h = Math.min(maxH, ri(10, 20));
    const right = left + w;
    const bottom = top + h;

    // Clockwise perimeter; each cell's flow points to the next cell (a closed
    // one-way loop). The whole top edge sits against the parking, so trucks drop
    // onto and return from the loop freely.
    const path = [];
    for (let gx = left; gx < right; gx++) path.push([gx, top]);
    for (let gy = top; gy < bottom; gy++) path.push([right, gy]);
    for (let gx = right; gx > left; gx--) path.push([gx, bottom]);
    for (let gy = bottom; gy > top; gy--) path.push([left, gy]);
    const cells = path.map(([gx, gy], i) => {
      const [nx, ny] = path[(i + 1) % path.length];
      return { gx, gy, dir: { dx: Math.sign(nx - gx), dy: Math.sign(ny - gy) } };
    });

    // A crusher just below the bottom edge — its top cells become dump bays.
    const cgx = ri(left + 1, right - 2);
    const crusher = { x: cgx, y: bottom + 1, w: 2, h: 2 };

    // Seed unrevealed ore in the blocks just inside the bottom edge near the
    // crusher, so a freshly-drilled block can actually feed the example haul.
    const ores = ['iron', 'copper', 'gold', 'carbon'];
    for (let gx = cgx - 2; gx <= cgx + 3; gx += 2) {
      const bx = Math.floor(gx / 2), by = Math.floor((bottom - 1) / 2);
      const b = this.mine.blocks[by]?.[bx];
      if (!b) continue;
      setOre(b, ores[ri(0, ores.length - 1)], ri(10, 20));
      b.explored = false;
    }

    return { cells, crusher };
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

  // Admin grant: adjust the balance (never below 0). Returns the new credit.
  addCredit(amount) {
    this.credit = Math.max(0, this.credit + Math.round(Number(amount) || 0));
    return this.credit;
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
    this.autopilot._bayCache = null;       // road change → recompute crusher bays
    this.autopilot._distCache.clear();     // …and every cached distance field
  }

  // Resize the (single) parking pad to a new sub-zone rectangle. Drawn road cells
  // now covered by the pad are dropped (superfluous road on the parking); roads
  // outside it stay, so entry/exit lanes remain connected. Returns the sanitized
  // rect. Slot layout and path caches are rebuilt.
  resizeParking(rect) {
    const { zoneCols, zoneRows } = this.grid;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    const x = clamp(rect.x, 0, zoneCols - 2);
    const y = clamp(rect.y, 0, zoneRows - 2);
    const w = clamp(rect.w, 2, zoneCols - x);
    const h = clamp(rect.h, 2, zoneRows - y);

    // Drop the old pad cells, then any drawn road now inside the new footprint.
    for (const [k, c] of [...this.roads.cells]) if (c.parking) this.roads.cells.delete(k);
    for (let gy = y; gy < y + h; gy++)
      for (let gx = x; gx < x + w; gx++) this.roads.cells.delete(key(gx, gy));

    this.roads.parkings = [];
    this.roads.addParking(x, y, w, h);

    this.autopilot._slots = null;          // rebuild the parking slot grid lazily
    this.autopilot._bayCache = null;
    this.autopilot._distCache.clear();
    return { x, y, w, h };
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
    return { ok: true, credit: this.credit, label: v.label, vehicle: this._vehicle(v) };
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
      parking: this.roads.parkings[0] || PARKING,
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

module.exports = {
  World, Vehicle, Roads, Autopilot,
  VIEW_W, VIEW_H, COLS, ROWS, DRILL_COST,
};
