// Authoritative server-side world. ALL gameplay state lives here and is advanced
// by tick(dt): vehicle movement, anti-collision, the haul autopilot, shovel
// relocation, loading/unloading, payouts. The client only renders snapshots and
// sends commands (drill, edit roads, drive manually, assign, reset).

const { generateMine, BLOCK_TONNAGE } = require('./mine');

// View space shared with the client renderer (so x/y come ready to draw).
const VIEW_W = 2048;
const VIEW_H = 1440;
const COLS = 49;
const ROWS = 36;

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
  excavator: { model: 'Liebherr R9100', bucket: 24 },
  oht:       { model: 'Liebherr T264', payload: 240 },
};

class Vehicle {
  constructor({ type, label, gx, gy, len, wid }) {
    this.type = type;
    this.label = label;
    this.gx = gx; this.gy = gy;
    this.tgx = gx; this.tgy = gy;
    this.len = len; this.wid = wid;
    this.speed = type === 'excavator' ? BASE_SPEED / 4
      : type === 'oht' ? BASE_SPEED / 2 : BASE_SPEED;
    this.roadOnly = type === 'oht';
    const spec = SPECS[type] || {};
    this.model = spec.model || type;
    this.payload = spec.payload || null;
    this.bucket = spec.bucket || null;
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
    this.crusher = null;
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

  setCrusher(x, y, w, h) { this.crusher = { x, y, w, h }; }

  // Replace the drawn road network (keeps parking pads intact).
  setNetwork(cells) {
    for (const [k, c] of [...this.cells]) if (!c.parking) this.cells.delete(k);
    if (!Array.isArray(cells)) return;
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
const BUCKET_TIME = 1.5;
const BUCKETS = 10;
const BUCKET_LOAD = 24;
const TRUCK_CAP = 240;
const DUMP_TIME = 5;
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
    this._crusherLock = null;
    this.shovels = new Set();
    this._shovelMove = new Map();
    this._manual = new Set();
    this.isFree = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) { for (const t of this.links.keys()) this._ensure(t); }
    else {
      for (const t of this.links.keys()) t.task = null;
      this._shovelLock.clear();
      this._crusherLock = null;
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
  _canTakeCrusher(truck)         { return !this._crusherLock || this._crusherLock === truck; }
  _tryLockCrusher(truck)         { if (this._canTakeCrusher(truck)) { this._crusherLock = truck; return true; } return false; }
  _unlockCrusher(truck)          { if (this._crusherLock === truck) this._crusherLock = null; }

  _freeLocks(truck) {
    for (const [s, h] of this._shovelLock) if (h === truck) this._shovelLock.delete(s);
    if (this._crusherLock === truck) this._crusherLock = null;
  }

  _updateShovels() {
    for (const shovel of this.shovels) {
      const move = this._shovelMove.get(shovel);
      if (move) {
        if (!shovel.moving && shovel.gx === move.gx && shovel.gy === move.gy)
          this._shovelMove.delete(shovel);
        continue;
      }
      if (this._manual.has(shovel)) continue;
      if (shovel.digging) continue;
      const bx = Math.floor(shovel.gx / 2);
      const by = Math.floor(shovel.gy / 2);
      const here = this.hooks.getBlock(bx, by);
      const hasOre = here && here.explored && here.ore && here.oreRemaining > 0;
      if (hasOre) continue;
      const next = this._richestAdjacentOre(bx, by);
      if (next) {
        this._shovelMove.set(shovel, {
          gx: next.bx * 2 + (shovel.gx % 2),
          gy: next.by * 2 + (shovel.gy % 2),
        });
      }
    }
  }

  _richestAdjacentOre(bx, by) {
    const NB = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let best = null;
    for (const [dx, dy] of NB) {
      const b = this.hooks.getBlock(bx + dx, by + dy);
      if (b && b.explored && b.ore && b.oreRemaining > 0 && (!best || b.oreRemaining > best.ore))
        best = { bx: bx + dx, by: by + dy, ore: b.oreRemaining };
    }
    return best;
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

  _tick(dt, truck, shovel) {
    const st = this.state.get(truck);
    if (!st) return;
    if (this._manual.has(truck)) { st.dir = null; return; }
    const sb = { bx: Math.floor(shovel.gx / 2), by: Math.floor(shovel.gy / 2) };

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
    const goals = this._crusherGoals();
    const from = this._logical(truck);
    if (!goals.size || !this._reachStatic(from, goals)) { st.phase = 'to_parking'; st.dir = null; return; }
    const a = this._advance(truck, goals, () => this._canTakeCrusher(truck));
    if (a.arrived) {
      if (this._tryLockCrusher(truck)) { st.phase = 'dumping'; st.timer = 0; }
      st.dir = null; return;
    }
    st.dir = a.dir;
  }

  _tickToParking(truck, st) {
    truck.task = null;
    const slot = this._parkSlot(truck);
    if (!slot) { st.dir = null; return; }
    const goals = new Set([key(slot.gx, slot.gy)]);
    const a = this._advance(truck, goals, null);
    if (a.arrived) { st.phase = 'parked'; st.timer = 0; st.dir = null; return; }
    st.dir = a.dir;
  }

  _tickParked(dt, truck, shovel, sb, st) {
    st.dir = null;
    truck.task = null;
    st.timer += dt;
    if (st.timer < PARK_RECHECK) return;
    st.timer = 0;
    const from = this._logical(truck);
    if (truck.load > 0) {
      if (this._reachStatic(from, this._crusherGoals())) { this._releaseSlot(truck); st.phase = 'to_crusher'; }
      return;
    }
    const block = this.hooks.getBlock(sb.bx, sb.by);
    const hasOre = block && block.explored && block.ore && block.oreRemaining > 0;
    if (hasOre && this._reachStatic(from, this._shovelGoals(sb))) {
      this._releaseSlot(truck);
      st.phase = 'to_shovel';
    }
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
    st.timer += dt;
    if (st.timer >= BUCKET_TIME) {
      st.timer -= BUCKET_TIME;
      st.bucket++;
      truck.load = Math.min(TRUCK_CAP, truck.load + BUCKET_LOAD);
      truck.loadOre = block.ore;
    }
    truck.task = { kind: 'load', progress: Math.min(1, (st.bucket + st.timer / BUCKET_TIME) / BUCKETS) };
    if (st.bucket >= BUCKETS || truck.load >= TRUCK_CAP) {
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
      this._unlockCrusher(truck);
      truck.load = 0; truck.loadOre = null; truck.task = null;
      st.dumpTotal = null; st.dumpOre = null;
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
      if (goals.has(key(nx, ny)) && !gate()) dir = null;
    }
    return { arrived: false, dir };
  }

  _shovelGoals(sb) { return this._bayCells(sb.bx * 2, sb.by * 2, sb.bx * 2 + 1, sb.by * 2 + 1); }

  _crusherGoals() {
    const cr = this.roads.crusher;
    if (!cr) return new Set();
    return this._bayCells(cr.x, cr.y, cr.x + cr.w - 1, cr.y + cr.h - 1);
  }

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

  _neighbors(c) {
    const cell = this.roads.cells.get(key(c.gx, c.gy));
    const cDir = (cell && !cell.parking) ? cell.dir : null;
    const out = [];
    for (const [dx, dy] of DIRS) {
      const nx = c.gx + dx;
      const ny = c.gy + dy;
      if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
      if (!this.roads.isRoad(nx, ny)) continue;
      if (cDir && dx === -cDir.dx && dy === -cDir.dy) continue;
      const nc = this.roads.cells.get(key(nx, ny));
      const nDir = (nc && !nc.parking) ? nc.dir : null;
      if (nDir && dx === -nDir.dx && dy === -nDir.dy) continue;
      out.push({ gx: nx, gy: ny });
    }
    return out;
  }
}

// ── World orchestrator ──────────────────────────────────────────────────────

function blockDistToParking(bx, by) {
  const dx = Math.max(PARK_BLOCKS.bx0 - bx, 0, bx - PARK_BLOCKS.bx1);
  const dy = Math.max(PARK_BLOCKS.by0 - by, 0, by - PARK_BLOCKS.by1);
  return Math.max(dx, dy);
}

function placeCrusher() {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pcx = (PARK_BLOCKS.bx0 + PARK_BLOCKS.bx1) / 2;
  const pcy = (PARK_BLOCKS.by0 + PARK_BLOCKS.by1) / 2;
  for (let i = 0; i < 800; i++) {
    const dist = 2 + Math.random() * 13;
    const ang = Math.random() * Math.PI * 2;
    const cbx = clamp(Math.round(pcx + Math.cos(ang) * dist), 0, COLS - 1);
    const cby = clamp(Math.round(pcy + Math.sin(ang) * dist), 0, ROWS - 1);
    const d = blockDistToParking(cbx, cby);
    if (d >= 2 && d <= 15) return { x: cbx * 2, y: cby * 2, w: 2, h: 2 };
  }
  const fbx = clamp(Math.round(pcx) + 8, 0, COLS - 1);
  const fby = clamp(Math.round(pcy) + 8, 0, ROWS - 1);
  return { x: fbx * 2, y: fby * 2, w: 2, h: 2 };
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
    this.crusher = placeCrusher();
    this.dirty = new Map();

    this.roads = new Roads(this.grid);
    this.roads.addParking(PARKING.x, PARKING.y, PARKING.w, PARKING.h);
    this.roads.setCrusher(this.crusher.x, this.crusher.y, this.crusher.w, this.crusher.h);

    const zone = Math.min(this.grid.zoneW, this.grid.zoneH);
    const mk = (o) => { const v = new Vehicle(o); v.place(this.grid); return v; };

    const lv  = mk({ type: 'pickup', label: 'LV01', gx: 6, gy: 8, len: zone * 0.95, wid: zone * 0.57 });
    const hex1 = mk({ type: 'excavator', label: 'HEX01', gx: 12, gy: 12, len: zone * 1.2, wid: zone * 0.95 });
    const hex2 = mk({ type: 'excavator', label: 'HEX02', gx: 20, gy: 16, len: zone * 1.2, wid: zone * 0.95 });
    const P = PARKING;
    const oht1 = mk({ type: 'oht', label: 'OHT01', gx: P.x + 1, gy: P.y, len: zone * 1.7, wid: zone * 0.7 });
    const oht2 = mk({ type: 'oht', label: 'OHT02', gx: P.x + 3, gy: P.y, len: zone * 1.7, wid: zone * 0.7 });
    const oht3 = mk({ type: 'oht', label: 'OHT03', gx: P.x + 5, gy: P.y, len: zone * 1.7, wid: zone * 0.7 });
    const oht4 = mk({ type: 'oht', label: 'OHT04', gx: P.x + 1, gy: P.y + 1, len: zone * 1.7, wid: zone * 0.7 });
    this.vehicles = [lv, hex1, hex2, oht1, oht2, oht3, oht4];
    this.byLabel = new Map(this.vehicles.map((v) => [v.label, v]));

    this.autopilot = new Autopilot(this.grid, this.roads, {
      getBlock: (bx, by) => this.mine.blocks[by]?.[bx],
      mineBlock: (bx, by, amount) => this._mineBlock(bx, by, amount),
      deliver: (ore, tons) => this._deliver(ore, tons),
    });
    this.autopilot.addShovel(hex1);
    this.autopilot.addShovel(hex2);
    this.autopilot.assign(oht1, hex1);
    this.autopilot.assign(oht2, hex1);
    this.autopilot.assign(oht3, hex2);
    this.autopilot.assign(oht4, hex2);
    this.autopilot.setEnabled(true);
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

  setRoads(cells) { this.roads.setNetwork(cells); }

  control(label, { dir, release } = {}) {
    const v = this.byLabel.get(label);
    if (!v) return;
    if (release) {
      v.manual = false; v.manualDir = null;
      if (v.type === 'oht') this.autopilot.clearManual(v);
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
      crusher: this.crusher,
      roads: this.roads.serialize(),
      vehicles: this.vehicles.map((v) => this._vehicle(v)),
      blocks: this.mine.blocks.map((row) => row.map((b) => this._publicBlock(b))),
    };
  }

  // Lightweight, high-frequency snapshot: credit, all vehicles, changed blocks.
  liveState() {
    const blocks = [...this.dirty.values()].map((b) => this._publicBlock(b));
    this.dirty.clear();
    return {
      credit: this.credit,
      vehicles: this.vehicles.map((v) => this._vehicle(v)),
      blocks,
    };
  }
}

module.exports = { World, VIEW_W, VIEW_H, COLS, ROWS, DRILL_COST };
