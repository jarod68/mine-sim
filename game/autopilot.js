// Haul autopilot: shovel relocation, truck task FSM (to_shovel / load / to_crusher
// / dump / park), shortest-path distance fields, anti-jam (detour / off-road dodge /
// head-on yield). Drives instances handed in via the constructor + hooks.

const { DIRS, BUCKET_TIME, TRUCK_CAP, DUMP_TIME, PARK_RECHECK, STUCK_DETOUR, STUCK_DODGE, DIST_CACHE_MAX, PARK_HEADING, key } = require('./constants');

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

  // The road network changed (drawn roads, a new crusher): drop the cached crusher
  // bays and every cached distance field so routes are re-planned.
  invalidateRoadCaches() { this._bayCache = null; this._distCache.clear(); }

  // The parking pad moved/resized: rebuild the parking slot grid lazily.
  invalidateSlots() { this._slots = null; }

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
      // sub-zone where the shovel's body clears every surrounding road. If no fully
      // road-clear spot exists nearby (shovel hemmed in by roads), relax the
      // constraint so it still moves to ore and keeps working instead of stalling.
      const next = this._bestOreInRadius(shovel, bx, by, 3, false)
                || this._bestOreInRadius(shovel, bx, by, 3, true);
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

  // How many cells of the shovel's graphic footprint, centred on (gx,gy), sit on a
  // road. Infinity if the footprint would leave the map. 0 means it clears every
  // road — so we never *prefer* parking straddling a road, but can fall back to it.
  _footprintRoadCount(shovel, gx, gy) {
    let n = 0;
    for (const c of shovel.footprintAt(gx, gy, this.grid)) {
      if (c.gx < 0 || c.gy < 0 || c.gx >= this.grid.zoneCols || c.gy >= this.grid.zoneRows) return Infinity;
      if (this.roads.isRoad(c.gx, c.gy)) n++;
    }
    return n;
  }

  // A sub-zone of block (bx,by) where the shovel can sit. Prefers the cell matching
  // its current parity, and a body that fully clears every road. When `relaxed`,
  // falls back to the in-bounds sub-zone with the *fewest* road cells (so a shovel
  // boxed in by roads still relocates and keeps working rather than idling). Returns
  // { gx, gy } | null.
  _shovelPlacement(shovel, bx, by, relaxed = false) {
    const xs = (shovel.gx % 2) === 0 ? [0, 1] : [1, 0];
    const ys = (shovel.gy % 2) === 0 ? [0, 1] : [1, 0];
    let fallback = null, fewest = Infinity;
    for (const oy of ys)
      for (const ox of xs) {
        const gx = bx * 2 + ox;
        const gy = by * 2 + oy;
        const roads = this._footprintRoadCount(shovel, gx, gy);
        if (roads === 0) return { gx, gy };                        // body fully off the roads
        if (relaxed && roads < fewest) { fewest = roads; fallback = { gx, gy }; }
      }
    return relaxed ? fallback : null;
  }

  // Best EXPLORED ore block within `R` blocks (Chebyshev) of (bx,by) for `shovel`
  // to move to. Never reveals undrilled ground, never a block on a road, and only
  // blocks where a road-clear placement exists for this shovel's body. Priority:
  // road access first, then nearest, then richest. Returns { bx, by, place } | null.
  _bestOreInRadius(shovel, bx, by, R, relaxed = false) {
    let best = null;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nbx = bx + dx;
        const nby = by + dy;
        const b = this.hooks.getBlock(nbx, nby);
        if (!(b && b.explored && b.ore && b.oreRemaining > 0)) continue;
        if (!relaxed && this._blockOnRoad(nbx, nby)) continue;   // strict: never sit on a road
        const place = this._shovelPlacement(shovel, nbx, nby, relaxed);
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
    if (st.dodge) { this._tickDodge(truck, st); return; }   // skirting a blocking shovel
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
    this._advanceTail(truck, goals, gid, st, a);
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

  // ── off-road dodge ──
  // A truck on the road can be boxed in by a shovel that has settled across (or
  // beside) its only path. After it has waited long enough — and the obstacle is
  // genuinely a shovel, not another truck — let it skirt the shovel off-road and
  // rejoin the network past it to continue its mission. (Head-on truck stand-offs
  // are handled instead by `_resolveDeadlocks` / `_yieldStep`, which now pulls the
  // yielder OFF the road rather than reversing it the wrong way.)
  _advanceTail(truck, goals, gid, st, a) {
    if (a.dir === null && this._startDodgeIfStuck(truck, goals, gid, st)) {
      this._tickDodge(truck, st);
      return;
    }
    st.dir = a.dir;
  }

  // Every grid cell currently covered by a shovel's body.
  _shovelCells() {
    const s = new Set();
    for (const sh of this.shovels)
      for (const c of sh.footprintAt(sh.gx, sh.gy, this.grid)) s.add(key(c.gx, c.gy));
    return s;
  }

  // The stationary truck (other than `self`) covering cell (gx,gy), or null — a
  // real jam, not a truck merely passing through.
  _stationaryTruckAt(gx, gy, self) {
    for (const [t] of this.state) {
      if (t === self || t.moving) continue;
      for (const c of t.collisionCells(t.gx, t.gy, this.grid)) if (c.gx === gx && c.gy === gy) return t;
    }
    return null;
  }

  // What a truck is queueing for: 'C' (any crusher), 'S:<label>' (its assigned
  // shovel), or null (parked / in transit). Two trucks with the same value are in
  // the same queue and must wait in line, not skirt one another.
  _queueDest(truck, st) {
    switch (st && st.phase) {
      case 'to_crusher': case 'dumping': return 'C';
      case 'to_shovel': case 'loading': case 'docking': case 'undocking': {
        const sh = this.links.get(truck);
        return sh ? `S:${sh.label}` : null;
      }
      default: return null;
    }
  }

  // Start a dodge when the truck has been stuck long enough AND the cell it wants
  // is held by a real obstacle — a shovel, or another truck that's sitting still
  // (a jam / stand-off). Picks a nearby free road cell that makes progress toward
  // the goal (past the obstacle) to head for off-road, so the truck stops
  // congesting the lane instead of waiting indefinitely. Never skirts a truck that
  // is queueing for the SAME destination — those wait calmly in line.
  _startDodgeIfStuck(truck, goals, gid, st) {
    if (st.stuck < STUCK_DODGE || !st.want) return false;
    const wk = key(st.want.gx, st.want.gy);
    const blockTruck = this._stationaryTruckAt(st.want.gx, st.want.gy, truck);
    if (blockTruck) {
      const d = this._queueDest(truck, st);
      if (d && d === this._queueDest(blockTruck, this.state.get(blockTruck))) return false; // same queue → wait behind
    }
    if (!this._shovelCells().has(wk) && !blockTruck) return false;
    const lc = this._logical(truck);
    const target = this._dodgeTarget(truck, goals, gid, lc);
    if (!target) return false;
    st.dodge = { target, fromGx: lc.gx, fromGy: lc.gy, ticks: 0 };
    st.stuck = 0;
    return true;
  }

  // Nearest free, non-shovel road cell that is strictly closer to the goal than
  // the truck's current cell — i.e. a foothold on the far side of the shovel.
  _dodgeTarget(truck, goals, gid, lc) {
    const field = this._distField(goals, gid);
    const dC = field.get(key(lc.gx, lc.gy));
    if (dC == null) return null;
    const shovelCells = this._shovelCells();
    let best = null, bestScore = Infinity;
    const R = 6;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const gx = lc.gx + dx, gy = lc.gy + dy;
        if (gx < 0 || gy < 0 || gx >= this.grid.zoneCols || gy >= this.grid.zoneRows) continue;
        if (!this.roads.isRoad(gx, gy) || shovelCells.has(key(gx, gy))) continue;
        const d = field.get(key(gx, gy));
        if (d == null || d >= dC) continue;            // must make progress toward the goal
        if (!this._canOccupy(truck, gx, gy, 0, 0)) continue;
        const score = Math.abs(dx) + Math.abs(dy) + d;  // near the truck AND near the goal
        if (score < bestScore) { bestScore = score; best = { gx, gy }; }
      }
    return best;
  }

  // Drive an in-progress dodge: step off-road toward the foothold; the instant the
  // truck is back on a (different) road cell, hand control to the normal autopilot.
  _tickDodge(truck, st) {
    truck.task = null;
    truck.offroad = true;
    const lc = this._logical(truck);
    const backOnRoad = !truck.moving && this.roads.isRoad(lc.gx, lc.gy)
      && !(lc.gx === st.dodge.fromGx && lc.gy === st.dodge.fromGy);
    if (backOnRoad || (st.dodge.ticks = (st.dodge.ticks || 0) + 1) > 150) {
      st.dodge = null; truck.offroad = false; st.dir = null; st.stuck = 0;
      return;
    }
    st.dir = this._dodgeStep(truck, st.dodge.target);
    if (!st.dir && !truck.moving) { st.dodge = null; truck.offroad = false; }  // boxed in — give up
  }

  // First step of a short off-road path (bounded BFS over free cells) from the
  // truck to `target`. Unlike the greedy `_offroadStep`, this can detour sideways
  // to get AROUND an obstacle such as a shovel body. Null if no path in the box.
  _dodgeStep(truck, target) {
    const a = this._logical(truck);
    if (a.gx === target.gx && a.gy === target.gy) return null;
    const pad = 4;
    const minx = Math.max(0, Math.min(a.gx, target.gx) - pad);
    const maxx = Math.min(this.grid.zoneCols - 1, Math.max(a.gx, target.gx) + pad);
    const miny = Math.max(0, Math.min(a.gy, target.gy) - pad);
    const maxy = Math.min(this.grid.zoneRows - 1, Math.max(a.gy, target.gy) + pad);
    const came = new Map([[key(a.gx, a.gy), null]]);
    const queue = [{ gx: a.gx, gy: a.gy }];
    let found = null;
    for (let h = 0; h < queue.length && !found; h++) {
      const c = queue[h];
      if (c.gx === target.gx && c.gy === target.gy) { found = c; break; }
      for (const [dx, dy] of DIRS) {
        const nx = c.gx + dx, ny = c.gy + dy;
        if (nx < minx || nx > maxx || ny < miny || ny > maxy) continue;
        const k = key(nx, ny);
        if (came.has(k)) continue;
        const isTarget = nx === target.gx && ny === target.gy;
        if (!isTarget && !this._canOccupy(truck, nx, ny, dx, dy)) continue;
        came.set(k, c);
        queue.push({ gx: nx, gy: ny });
      }
    }
    if (!found) return null;
    let cur = found, prev = came.get(key(cur.gx, cur.gy));
    while (prev && !(prev.gx === a.gx && prev.gy === a.gy)) { cur = prev; prev = came.get(key(cur.gx, cur.gy)); }
    return [cur.gx - a.gx, cur.gy - a.gy];
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
    this._advanceTail(truck, goals, 'C', st, a);
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
    const gid = `P:${slot.gx},${slot.gy}`;
    const a = this._advance(truck, goals, gid, null);
    if (a.arrived) { st.phase = 'parked'; st.timer = 0; st.dir = null; truck.heading = PARK_HEADING; return; }
    this._advanceTail(truck, goals, gid, st, a);
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
      if (st.dumpTotal > 0) this.hooks.deliver(st.dumpOre, st.dumpTotal, st.crusherIdx);
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
    if (proj < 0 || (!adjacent && proj === 0)) { st.yield = null; st.stuck = 0; truck.offroad = false; return null; } // passed → resume
    if (truck.moving) return st.dir;          // finish the current hop
    if (y.parked) return null;                // tucked aside → hold until it passes
    let pocket = null, back = null;
    for (const n of this._neighbors(a)) {
      if (this.isFree && !this.isFree(n.gx, n.gy, truck)) continue;
      const along = (n.gx - a.gx) * y.axis[0] + (n.gy - a.gy) * y.axis[1];
      if (along === 0) pocket = n;            // off-axis escape (a side road)
      else if (along < 0) back = n;           // one cell back, away from the oncoming truck
    }
    if (pocket) { y.parked = true; return [pocket.gx - a.gx, pocket.gy - a.gy]; }
    // No side road: pull OFF the road to the side to clear the lane, rather than
    // reversing the wrong way down it.
    const side = this._sideStepOff(truck, a, y.axis);
    if (side) { y.parked = true; truck.offroad = true; return side; }
    if (back) return [back.gx - a.gx, back.gy - a.gy];
    return null;                              // boxed in — wait
  }

  // A free cell perpendicular to the conflict axis (road or not) the truck can pull
  // into to clear a one-lane stand-off — used instead of reversing against the flow.
  _sideStepOff(truck, a, axis) {
    const perp = axis[0] === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [dx, dy] of perp) {
      const gx = a.gx + dx, gy = a.gy + dy;
      if (gx < 0 || gy < 0 || gx >= this.grid.zoneCols || gy >= this.grid.zoneRows) continue;
      if (this._canOccupy(truck, gx, gy, dx, dy)) return [dx, dy];
    }
    return null;
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

module.exports = { Autopilot };
