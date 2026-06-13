// Autopilot: automatic haul cycle for OHTs assigned to a shovel.
//
// Cycle per assigned truck: drive to a road cell next to the shovel → wait while
// the shovel fills it over 10 bucket passes (240 t, ~15 s) and the block's ore
// is decremented (server-authoritative) → drive to a road cell next to the
// crusher → wait while dumping (~5 s) and get paid → repeat.
//
// Driving follows the one-way road direction (chevrons); parking pads allow free
// manoeuvring. Pathfinding uses directed BFS and picks the shortest reachable
// route. Manual driving is NOT direction-constrained (handled in Vehicle).
//
// Requires: the shovel sits on a revealed block carrying ore, and a road cell
// lies within 1 block of it (and of the crusher).

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const BUCKET_TIME = 1.5;   // s per bucket pass → 10 × 1.5 = 15 s to load
const BUCKETS = 10;
const BUCKET_LOAD = 24;    // tonnes per bucket
const TRUCK_CAP = 240;     // 10 × 24
const DUMP_TIME = 5;       // s to dump at the crusher

const key = (gx, gy) => `${gx},${gy}`;

export class Autopilot {
  // hooks: { getBlock(bx,by), mineBlock(bx,by,amount)->Promise<tons>, deliver(ore,tons) }
  constructor(grid, roads, hooks) {
    this.grid = grid;
    this.roads = roads;
    this.hooks = hooks;
    this.enabled = false;
    this.links = new Map();   // truck -> shovel
    this.state = new Map();   // truck -> { phase, dir, timer, bucket, lck, path }
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) for (const t of this.links.keys()) this._ensure(t);
    if (!on) for (const t of this.links.keys()) { const v = t; v.task = null; }
  }

  assign(truck, shovel) {
    if (shovel) this.links.set(truck, shovel);
    else { this.links.delete(truck); this.state.delete(truck); truck.task = null; }
    this._ensure(truck);
  }

  assignedShovel(truck) { return this.links.get(truck) || null; }
  controls(v) { return this.enabled && this.links.has(v); }
  dirFor(v) { return this.state.get(v)?.dir ?? null; }

  _ensure(truck) {
    if (!this.links.has(truck)) return;
    if (!this.state.get(truck)) {
      this.state.set(truck, { phase: 'to_shovel', dir: null, timer: 0, bucket: 0, lck: null, path: null });
    }
  }

  update(dt) {
    if (!this.enabled) return;
    for (const shovel of this.links.values()) shovel.digging = false; // reset each frame
    for (const [truck, shovel] of this.links) this._tick(dt, truck, shovel);
  }

  _tick(dt, truck, shovel) {
    const st = this.state.get(truck);
    if (!st) return;

    const shovelBlock = { bx: Math.floor(shovel.gx / 2), by: Math.floor(shovel.gy / 2) };

    if (st.phase === 'loading') { st.dir = null; shovel.digging = true; this._load(dt, truck, shovelBlock, st); return; }
    if (st.phase === 'dumping') { st.dir = null; this._dump(dt, truck, st); return; }

    // Waiting at the parking with nothing to do — re-check periodically and
    // resume as soon as loading/unloading becomes possible again.
    if (st.phase === 'parked') {
      st.dir = null;
      truck.task = null;
      st.timer += dt;
      if (st.timer >= 0.7) {
        st.timer = 0;
        if (truck.load > 0 && this._canUnload(truck)) st.phase = 'to_crusher';
        else if (truck.load <= 0 && this._canLoad(truck, shovelBlock)) st.phase = 'to_shovel';
      }
      return;
    }

    // If the current job is impossible (no ore / no reachable road), drive back
    // to the parking and wait there.
    if (st.phase === 'to_shovel' && !this._canLoad(truck, shovelBlock)) st.phase = 'to_parking';
    if (st.phase === 'to_crusher' && !this._canUnload(truck)) st.phase = 'to_parking';

    truck.task = null;
    let goals;
    if (st.phase === 'to_shovel') {
      this._releaseSlot(truck);
      goals = this._roadGoals(blockRect(shovelBlock));
    } else if (st.phase === 'to_crusher') {
      this._releaseSlot(truck);
      goals = this._roadGoals(this._crusherRect());
    } else {
      // head to this truck's own parking slot, so they line up side by side
      const slot = this._parkSlot(truck);
      goals = slot ? new Set([key(slot.gx, slot.gy)]) : new Set();
    }

    if (!goals || goals.size === 0) { st.dir = null; return; }

    // Plan from the truck's logical cell (where it's heading), so the next step
    // is ready on arrival (smooth) and it stops exactly on the goal.
    const lc = truck.moving ? { gx: truck.tgx, gy: truck.tgy } : { gx: truck.gx, gy: truck.gy };

    if (goals.has(key(lc.gx, lc.gy))) {
      st.dir = null;                       // hold on the goal cell
      if (!truck.moving) {
        if (st.phase === 'to_shovel') { st.phase = 'loading'; st.timer = 0; st.bucket = 0; truck.load = 0; }
        else if (st.phase === 'to_crusher') { st.phase = 'dumping'; st.timer = 0; }
        else { st.phase = 'parked'; st.timer = 0; }
      }
      return;
    }

    // Recompute each tick so the truck reacts to other vehicles: it routes
    // around occupied cells when possible, otherwise waits behind them.
    const path = this._path(lc, goals, truck, true);
    st.dir = path && path.length >= 2
      ? [path[1].gx - path[0].gx, path[1].gy - path[0].gy]
      : null;
  }

  // Can the truck (eventually) load? Needs ore on the shovel's block and a
  // statically reachable road within 1 block of it.
  _canLoad(truck, shovelBlock) {
    const block = this.hooks.getBlock(shovelBlock.bx, shovelBlock.by);
    if (!block || !block.explored || !block.ore || block.oreRemaining <= 0) return false;
    return this._reachable(truck, this._roadGoals(blockRect(shovelBlock)));
  }

  _canUnload(truck) {
    return this._reachable(truck, this._roadGoals(this._crusherRect()));
  }

  _reachable(truck, goals) {
    if (!goals || goals.size === 0) return false;
    const lc = truck.moving ? { gx: truck.tgx, gy: truck.tgy } : { gx: truck.gx, gy: truck.gy };
    if (goals.has(key(lc.gx, lc.gy))) return true;
    return this._path(lc, goals, truck, false) != null;
  }

  // Distinct parking slots (one per truck) so returning trucks line up side by
  // side inside the pad rather than piling at the entrance.
  _buildSlots() {
    this._slots = [];
    this._slotByTruck = new Map();
    for (const p of this.roads.parkings || []) {
      for (let gy = p.y; gy < p.y + p.h; gy++) {
        for (let gx = p.x; gx < p.x + p.w; gx += 2) this._slots.push({ gx, gy });
      }
    }
  }

  _parkSlot(truck) {
    if (!this._slots) this._buildSlots();
    let slot = this._slotByTruck.get(truck);
    if (!slot) {
      const taken = new Set([...this._slotByTruck.values()].map((s) => key(s.gx, s.gy)));
      slot = this._slots.find((s) => !taken.has(key(s.gx, s.gy)));
      if (slot) this._slotByTruck.set(truck, slot);
    }
    return slot;
  }

  _releaseSlot(truck) {
    if (this._slotByTruck) this._slotByTruck.delete(truck);
  }

  _load(dt, truck, shovelBlock, st) {
    const block = this.hooks.getBlock(shovelBlock.bx, shovelBlock.by);
    if (!block || !block.explored || !block.ore || block.oreRemaining <= 0) {
      truck.task = null;
      st.timer += dt;
      if (st.timer >= 0.5) { st.phase = 'to_crusher'; st.timer = 0; st.lck = null; }
      return;
    }

    st.timer += dt;
    if (st.timer >= BUCKET_TIME) {
      st.timer -= BUCKET_TIME;
      st.bucket += 1;
      truck.load = Math.min(TRUCK_CAP, truck.load + BUCKET_LOAD);
      truck.loadOre = block.ore;
    }
    truck.task = { kind: 'load', progress: Math.min(1, (st.bucket + st.timer / BUCKET_TIME) / BUCKETS) };

    if (st.bucket >= BUCKETS || truck.load >= TRUCK_CAP) {
      const want = truck.load;
      this.hooks.mineBlock(shovelBlock.bx, shovelBlock.by, want).then((mined) => { truck.load = mined; });
      truck.task = null;
      st.phase = 'to_crusher';
      st.timer = 0;
      st.bucket = 0;
      st.lck = null;
    }
  }

  _dump(dt, truck, st) {
    st.timer += dt;
    truck.task = { kind: 'dump', progress: Math.min(1, st.timer / DUMP_TIME) };
    if (st.timer >= DUMP_TIME) {
      if (truck.load > 0) this.hooks.deliver(truck.loadOre, truck.load);
      truck.load = 0;
      truck.loadOre = null;
      truck.task = null;
      st.phase = 'to_shovel';
      st.timer = 0;
      st.lck = null;
    }
  }

  // Set of road-cell keys on a block that is the target block or shares an edge
  // with it (orthogonally adjacent) — so the truck ends up really beside the
  // shovel/crusher, not just touching a diagonal corner.
  _roadGoals(rect) {
    const set = new Set();
    for (const c of this.roads.cells.values()) {
      if (c.parking) continue;
      const cb = { bx: Math.floor(c.gx / 2), by: Math.floor(c.gy / 2) };
      if (blockRectManhattan(cb, rect) <= 1) set.add(key(c.gx, c.gy));
    }
    return set;
  }

  _crusherRect() {
    const cr = this.roads.crusher;
    if (!cr) return { bx0: -9, by0: -9, bx1: -9, by1: -9 };
    return {
      bx0: Math.floor(cr.x / 2),
      by0: Math.floor(cr.y / 2),
      bx1: Math.floor((cr.x + cr.w - 1) / 2),
      by1: Math.floor((cr.y + cr.h - 1) / 2),
    };
  }

  // Successors of a cell, respecting one-way circulation but allowing turns at
  // junctions (T / X). The rule: you may step to an adjacent road as long as you
  // don't go backward out of the current cell and don't enter the next cell
  // against its flow. Parking cells are omnidirectional (free manoeuvring).
  _neighbors(c) {
    const cell = this.roads.cells.get(key(c.gx, c.gy));
    const cDir = cell && !cell.parking ? cell.dir : null;
    const out = [];
    for (const [dx, dy] of DIRS) {
      const nx = c.gx + dx;
      const ny = c.gy + dy;
      if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
      if (!this.roads.isRoad(nx, ny)) continue;
      if (cDir && dx === -cDir.dx && dy === -cDir.dy) continue;      // no U-turn out of C
      const ncell = this.roads.cells.get(key(nx, ny));
      const nDir = ncell && !ncell.parking ? ncell.dir : null;
      if (nDir && dx === -nDir.dx && dy === -nDir.dy) continue;      // not against N's flow
      out.push({ gx: nx, gy: ny });
    }
    return out;
  }

  // Directed BFS to the nearest cell in `goals` (shortest reachable route),
  // avoiding cells occupied by other vehicles (except the goal itself).
  _path(from, goals, truck, avoid) {
    if (!this.roads.isRoad(from.gx, from.gy)) return null;
    const start = { gx: from.gx, gy: from.gy };
    const queue = [start];
    const seen = new Set([key(start.gx, start.gy)]);
    const prev = new Map();

    while (queue.length) {
      const c = queue.shift();
      if (goals.has(key(c.gx, c.gy)) && !(c.gx === start.gx && c.gy === start.gy)) {
        const path = [c];
        let k = key(c.gx, c.gy);
        while (prev.has(k)) { const p = prev.get(k); path.unshift(p); k = key(p.gx, p.gy); }
        return path;
      }
      for (const n of this._neighbors(c)) {
        const nk = key(n.gx, n.gy);
        if (seen.has(nk)) continue;
        // when avoiding, skip occupied cells unless they are a goal (stop behind)
        if (avoid && this.isFree && !goals.has(nk) && !this.isFree(n.gx, n.gy, truck)) continue;
        seen.add(nk);
        prev.set(nk, c);
        queue.push(n);
      }
    }
    return null;
  }
}

function blockRect(b) {
  return { bx0: b.bx, by0: b.by, bx1: b.bx, by1: b.by };
}

function blockRectManhattan(cb, r) {
  const dx = Math.max(r.bx0 - cb.bx, 0, cb.bx - r.bx1);
  const dy = Math.max(r.by0 - cb.by, 0, cb.by - r.by1);
  return dx + dy;
}
