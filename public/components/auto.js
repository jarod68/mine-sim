// Autopilot — haul cycle with physical convoy queuing
//
// Each OHT assigned to a shovel runs an endless cycle:
//
//   to_shovel ─▶ loading ─▶ to_crusher ─▶ dumping ─▶ to_shovel ─▶ …
//
// Exclusive stations
// ──────────────────
//   • A shovel loads ONE truck at a time (one lock per shovel).
//   • The crusher unloads ONE truck at a time (one global lock).
// A truck that reaches a station whose lock is taken simply holds position and
// retries the lock every tick. The instant the working truck releases the lock
// it is re-acquired — often in the very same update() pass — so loading and
// dumping overlap as much as physically possible (one truck loads while another
// dumps).
//
// Physical queue
// ──────────────
// Queuing is not a state — it is emergent. _pathToward() always drives a truck
// as close as it can get: straight to a free bay, or, when every approach cell
// ahead is occupied, to the nearest reachable cell behind the convoy. The
// anti-collision in Vehicle.update then keeps a one-cell gap, so trucks line up
// nose-to-tail on the road. A truck never steps INTO an empty loading/dumping
// bay unless it can take the lock (the "gate"), so waiting trucks never block a
// bay they cannot use.
//
// Parking fallback
// ────────────────
// If no useful work is possible — the shovel block is exhausted/unreachable and
// the truck is empty, or the crusher is unreachable — the truck drives back to
// its parking slot and re-evaluates periodically, resuming the moment a cycle
// becomes possible again.
//
// Road rules: directed BFS, no U-turns, no wrong-way entry, omnidirectional on
// parking pads.

const DIRS        = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BUCKET_TIME = 1.5;   // s per bucket pass → 10 × 1.5 = 15 s for a full load
const BUCKETS     = 10;
const BUCKET_LOAD = 24;    // t per bucket
const TRUCK_CAP   = 240;
const DUMP_TIME   = 5;     // s to dump at the crusher
const PARK_RECHECK = 0.4;  // s between parked re-evaluations

const key = (gx, gy) => `${gx},${gy}`;

export class Autopilot {
  // hooks: { getBlock(bx,by), mineBlock(bx,by,amount)→Promise<tons>, deliver(ore,tons) }
  constructor(grid, roads, hooks) {
    this.grid  = grid;
    this.roads = roads;
    this.hooks = hooks;
    this.enabled = false;
    this.links = new Map();        // truck  → shovel
    this.state = new Map();        // truck  → { phase, dir, timer, bucket }
    this._shovelLock  = new Map(); // shovel → truck (current loader)
    this._crusherLock = null;      // truck (current dumper) | null
    this.shovels      = new Set(); // every registered excavator (for relocation)
    this._shovelMove  = new Map(); // shovel → { gx, gy } relocation target cell
    this._manual      = new Set(); // shovels under manual control (no auto-move)
    this.isFree = null;            // injected by Fleet: (gx,gy,self) → bool
  }

  // ── Public API ──────────────────────────────────────────────────────────

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      for (const t of this.links.keys()) this._ensure(t);
    } else {
      for (const t of this.links.keys()) t.task = null;
      this._shovelLock.clear();
      this._crusherLock = null;
      this._shovelMove.clear();
    }
  }

  // Register an excavator so it auto-relocates to adjacent ore when exhausted,
  // even before any truck is assigned to it.
  addShovel(shovel) { if (shovel) this.shovels.add(shovel); }

  // The player took manual control of a vehicle (arrow keys). Works for both:
  //   • shovel — cancels any pending relocation and stops auto-relocating it.
  //   • truck  — releases its station locks and clears its task so it stops
  //              hauling; it is driven entirely by the keyboard until released.
  setManual(v) {
    this._manual.add(v);
    this._shovelMove.delete(v);  // shovel: cancel relocation (no-op for trucks)
    this._freeLocks(v);          // truck: drop any shovel/crusher lock it holds
    v.task = null;
  }

  // Hand a truck back to the autopilot (called when it is deselected). It
  // re-plans from its current position: deliver if loaded, else fetch more ore.
  clearManual(v) {
    if (!this._manual.has(v)) return;
    this._manual.delete(v);
    const st = this.state.get(v);
    if (st) {
      st.phase = v.load > 0 ? 'to_crusher' : 'to_shovel';
      st.dir = null;
      st.timer = 0;
    }
  }

  isManual(v) { return this._manual.has(v); }

  assign(truck, shovel) {
    this._freeLocks(truck);
    if (shovel) {
      this.links.set(truck, shovel);
      this.shovels.add(shovel);
    } else {
      this.links.delete(truck);
      this.state.delete(truck);
      truck.task = null;
    }
    this._ensure(truck);
  }

  assignedShovel(t) { return this.links.get(t) ?? null; }

  // Fleet drives any vehicle for which controls() is true, using dirFor().
  // Trucks are driven by their state machine; a relocating shovel by its step.
  // A manually-controlled vehicle is NOT driven by the autopilot (keyboard wins).
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
    for (const s of this.shovels) s.digging = false; // reset per frame
    for (const [truck, shovel] of this.links) this._tick(dt, truck, shovel);
    this._updateShovels();
  }

  // ── Station locks ───────────────────────────────────────────────────────

  _shovelHolder(shovel)            { return this._shovelLock.get(shovel) ?? null; }
  _canTakeShovel(shovel, truck)    { const h = this._shovelHolder(shovel); return !h || h === truck; }
  _tryLockShovel(shovel, truck)    { if (this._canTakeShovel(shovel, truck)) { this._shovelLock.set(shovel, truck); return true; } return false; }
  _unlockShovel(shovel, truck)     { if (this._shovelLock.get(shovel) === truck) this._shovelLock.delete(shovel); }

  _canTakeCrusher(truck)           { return !this._crusherLock || this._crusherLock === truck; }
  _tryLockCrusher(truck)           { if (this._canTakeCrusher(truck)) { this._crusherLock = truck; return true; } return false; }
  _unlockCrusher(truck)            { if (this._crusherLock === truck) this._crusherLock = null; }

  _freeLocks(truck) {
    for (const [s, h] of this._shovelLock) if (h === truck) this._shovelLock.delete(s);
    if (this._crusherLock === truck) this._crusherLock = null;
  }

  // ── Shovel relocation ───────────────────────────────────────────────────
  //
  // When the block under a shovel is exhausted, the shovel walks to the richest
  // adjacent EXPLORED block that still holds ore. It drives there cell by cell
  // (Fleet moves it via controls()/dirFor()) and never relocates while actively
  // loading a truck. If no adjacent ore is known, it stays put — its trucks fall
  // back to parking until the player drills more ground nearby.

  _updateShovels() {
    for (const shovel of this.shovels) {
      const move = this._shovelMove.get(shovel);
      if (move) {
        if (!shovel.moving && shovel.gx === move.gx && shovel.gy === move.gy)
          this._shovelMove.delete(shovel);     // arrived on the new block
        continue;                              // keep travelling otherwise
      }
      if (this._manual.has(shovel)) continue;  // player-controlled — never auto-move
      if (shovel.digging) continue;            // mid-load — don't abandon a truck

      const bx = Math.floor(shovel.gx / 2);
      const by = Math.floor(shovel.gy / 2);
      const here   = this.hooks.getBlock(bx, by);
      const hasOre = here && here.explored && here.ore && here.oreRemaining > 0;
      if (hasOre) continue;                    // still productive

      const next = this._richestAdjacentOre(bx, by);
      if (next) {
        this._shovelMove.set(shovel, {
          gx: next.bx * 2 + (shovel.gx % 2),   // keep the same in-block offset
          gy: next.by * 2 + (shovel.gy % 2),
        });
      }
    }
  }

  // Richest adjacent (8-neighbour) explored block that still has ore, or null.
  _richestAdjacentOre(bx, by) {
    const NB = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let best = null;
    for (const [dx, dy] of NB) {
      const b = this.hooks.getBlock(bx + dx, by + dy);
      if (b && b.explored && b.ore && b.oreRemaining > 0 &&
          (!best || b.oreRemaining > best.ore))
        best = { bx: bx + dx, by: by + dy, ore: b.oreRemaining };
    }
    return best;
  }

  // Next step [dx,dy] for a relocating shovel (diagonals allowed). Computed from
  // the LOGICAL cell (the target while mid-step) so the shovel stops exactly on
  // its destination instead of overshooting when Vehicle.update chains a step.
  _shovelStep(shovel) {
    const t = this._shovelMove.get(shovel);
    if (!t) return null;
    const cx = shovel.moving ? shovel.tgx : shovel.gx;
    const cy = shovel.moving ? shovel.tgy : shovel.gy;
    const dx = Math.sign(t.gx - cx);
    const dy = Math.sign(t.gy - cy);
    return (dx === 0 && dy === 0) ? null : [dx, dy];
  }

  // ── Per-truck state machine ─────────────────────────────────────────────

  _ensure(truck) {
    if (!this.links.has(truck) || this.state.get(truck)) return;
    this.state.set(truck, { phase: 'to_shovel', dir: null, timer: 0, bucket: 0 });
  }

  _tick(dt, truck, shovel) {
    const st = this.state.get(truck);
    if (!st) return;
    if (this._manual.has(truck)) { st.dir = null; return; } // driven by the player
    const sb = { bx: Math.floor(shovel.gx / 2), by: Math.floor(shovel.gy / 2) };

    switch (st.phase) {
      case 'loading':    st.dir = null; shovel.digging = true; this._doLoad(dt, truck, shovel, sb, st); return;
      case 'dumping':    st.dir = null; this._doDump(dt, truck, st);                                     return;
      case 'parked':     this._tickParked(dt, truck, shovel, sb, st);                                    return;
      case 'to_shovel':  this._tickToShovel(truck, shovel, sb, st);                                      return;
      case 'to_crusher': this._tickToCrusher(truck, st);                                                 return;
      case 'to_parking': this._tickToParking(truck, st);                                                 return;
      default:           st.phase = 'to_shovel'; st.dir = null;                                          return;
    }
  }

  // Drive toward the shovel and queue for loading.
  _tickToShovel(truck, shovel, sb, st) {
    truck.task = null;

    const block  = this.hooks.getBlock(sb.bx, sb.by);
    const hasOre = block && block.explored && block.ore && block.oreRemaining > 0;
    if (!hasOre) {
      // Nothing to mine here: deliver what we carry, else park and wait.
      this._unlockShovel(shovel, truck);
      st.phase = truck.load > 0 ? 'to_crusher' : 'to_parking';
      st.dir = null;
      return;
    }

    const goals = this._shovelGoals(sb);
    const from  = this._logical(truck);
    if (!goals.size || !this._reachStatic(from, goals)) {
      // No road reaches the shovel: deliver remaining load, else park.
      st.phase = truck.load > 0 ? 'to_crusher' : 'to_parking';
      st.dir = null;
      return;
    }

    const a = this._advance(truck, goals, () => this._canTakeShovel(shovel, truck));
    if (a.arrived) {
      // At a bay cell: grab the lock and load, or hold here and retry next tick.
      if (this._tryLockShovel(shovel, truck)) {
        st.phase = 'loading'; st.timer = 0; st.bucket = 0; truck.load = 0;
      }
      st.dir = null;
      return;
    }
    st.dir = a.dir;
  }

  // Drive toward the crusher and queue for dumping.
  _tickToCrusher(truck, st) {
    truck.task = null;

    const goals = this._crusherGoals();
    const from  = this._logical(truck);
    if (!goals.size || !this._reachStatic(from, goals)) {
      // Crusher unreachable: park (keeping the load) and retry later.
      st.phase = 'to_parking';
      st.dir = null;
      return;
    }

    const a = this._advance(truck, goals, () => this._canTakeCrusher(truck));
    if (a.arrived) {
      if (this._tryLockCrusher(truck)) { st.phase = 'dumping'; st.timer = 0; }
      st.dir = null;
      return;
    }
    st.dir = a.dir;
  }

  // Drive back to this truck's own parking slot.
  _tickToParking(truck, st) {
    truck.task = null;

    const slot = this._parkSlot(truck);
    if (!slot) { st.dir = null; return; }
    const goals = new Set([key(slot.gx, slot.gy)]);

    const a = this._advance(truck, goals, null);
    if (a.arrived) { st.phase = 'parked'; st.timer = 0; st.dir = null; return; }
    st.dir = a.dir;
  }

  // Idle at parking: resume the cycle as soon as it becomes possible.
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
    const block  = this.hooks.getBlock(sb.bx, sb.by);
    const hasOre = block && block.explored && block.ore && block.oreRemaining > 0;
    if (hasOre && this._reachStatic(from, this._shovelGoals(sb))) {
      this._releaseSlot(truck);
      st.phase = 'to_shovel';
    }
  }

  // ── Station work ────────────────────────────────────────────────────────

  _doLoad(dt, truck, shovel, sb, st) {
    const block = this.hooks.getBlock(sb.bx, sb.by);
    if (!block || !block.explored || !block.ore || block.oreRemaining <= 0) {
      // Ore ran out mid-load: release the bay and deliver what we have.
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
      truck.load    = Math.min(TRUCK_CAP, truck.load + BUCKET_LOAD);
      truck.loadOre = block.ore;
    }
    truck.task = {
      kind:     'load',
      progress: Math.min(1, (st.bucket + st.timer / BUCKET_TIME) / BUCKETS),
    };

    if (st.bucket >= BUCKETS || truck.load >= TRUCK_CAP) {
      const want = truck.load;
      this.hooks.mineBlock(sb.bx, sb.by, want).then((mined) => { truck.load = mined; });
      // Release the bay BEFORE pulling away so the next queued truck can begin
      // loading in the same update() pass — maximises simultaneous work.
      this._unlockShovel(shovel, truck);
      truck.task = null;
      st.phase = 'to_crusher';
      st.timer = 0;
      st.bucket = 0;
    }
  }

  _doDump(dt, truck, st) {
    // Capture the full load once, then drain the bed gradually so the payload %
    // counts down while dumping.
    if (st.dumpTotal == null) { st.dumpTotal = truck.load; st.dumpOre = truck.loadOre; }
    st.timer += dt;
    const progress = Math.min(1, st.timer / DUMP_TIME);
    truck.task = { kind: 'dump', progress };
    truck.load = st.dumpTotal * (1 - progress);  // bed empties as it dumps

    if (st.timer >= DUMP_TIME) {
      if (st.dumpTotal > 0) this.hooks.deliver(st.dumpOre, st.dumpTotal);
      // Release the crusher BEFORE pulling away so the next queued truck can
      // start dumping immediately.
      this._unlockCrusher(truck);
      truck.load    = 0;
      truck.loadOre = null;
      truck.task    = null;
      st.dumpTotal  = null;
      st.dumpOre    = null;
      st.phase = 'to_shovel';
      st.timer = 0;
    }
  }

  // ── Movement primitive ──────────────────────────────────────────────────

  _logical(truck) {
    return truck.moving ? { gx: truck.tgx, gy: truck.tgy } : { gx: truck.gx, gy: truck.gy };
  }

  // Decide the next step toward `goals`.
  //   • arrived = true  → the truck is stopped on a goal (bay) cell.
  //   • dir            → next [dx,dy] step, or null to hold position.
  // `gate` (optional): a predicate; when the next step would enter a goal/bay
  // cell and gate() is false, the truck holds one cell back instead of occupying
  // a bay it cannot use.
  _advance(truck, goals, gate) {
    const lc = this._logical(truck);
    if (goals.has(key(lc.gx, lc.gy))) return { arrived: !truck.moving, dir: null };

    let dir = this._nextDir(lc, goals, truck);
    if (dir && gate) {
      const nx = lc.gx + dir[0];
      const ny = lc.gy + dir[1];
      if (goals.has(key(nx, ny)) && !gate()) dir = null; // don't claim a busy bay
    }
    return { arrived: false, dir };
  }

  // ── Goals (loading / dumping bays) ──────────────────────────────────────
  //
  // A bay is a road cell ORTHOGONALLY ADJACENT to the station's sub-zone
  // footprint — i.e. literally touching one of its edges. This keeps the bay
  // tight (1–2 cells) so the lock-holder occupies it alone and the queue forms
  // cleanly on the approach road behind it.

  _shovelGoals(sb) {
    // The shovel's mining block spans the 2×2 sub-zone area of block (sb.bx,sb.by).
    return this._bayCells(sb.bx * 2, sb.by * 2, sb.bx * 2 + 1, sb.by * 2 + 1);
  }

  _crusherGoals() {
    const cr = this.roads.crusher;
    if (!cr) return new Set();
    return this._bayCells(cr.x, cr.y, cr.x + cr.w - 1, cr.y + cr.h - 1);
  }

  // Road cells touching the [x0..x1, y0..y1] sub-zone footprint on an edge
  // (orthogonal neighbours only — no diagonal corners).
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

  // ── Parking slots (one distinct slot per truck) ─────────────────────────

  _buildSlots() {
    this._slots       = [];
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

  _releaseSlot(truck) {
    if (this._slotByTruck) this._slotByTruck.delete(truck);
  }

  // ── Pathfinding ─────────────────────────────────────────────────────────

  _nextDir(from, goals, truck) {
    const path = this._pathToward(from, goals, truck);
    if (path && path.length >= 2)
      return [path[1].gx - path[0].gx, path[1].gy - path[0].gy];
    return null;
  }

  // Collision-aware directed BFS with a "closest reachable cell" fallback.
  //
  //   • A goal cell is returned the moment it's found (shortest route).
  //   • Goal/bay cells are NOT skipped when occupied: the truck heads right up to
  //     the active truck and is stopped one cell short by Vehicle.update.
  //   • Non-goal occupied cells ARE skipped, so the truck routes around or, if it
  //     can't, the BFS still returns a path to the nearest reachable cell —
  //     driving the truck to the back of the queue rather than stalling.
  _pathToward(from, goals, truck) {
    if (!this.roads.isRoad(from.gx, from.gy)) return null;

    const startKey = key(from.gx, from.gy);
    const queue = [{ gx: from.gx, gy: from.gy }];
    const seen  = new Set([startKey]);
    const prev  = new Map();

    const goalPts = [...goals].map((k) => { const [x, y] = k.split(','); return { gx: +x, gy: +y }; });
    const distToGoals = (gx, gy) => {
      let d = Infinity;
      for (const g of goalPts) d = Math.min(d, Math.abs(gx - g.gx) + Math.abs(gy - g.gy));
      return d;
    };

    let bestCell = null;
    let bestDist = Infinity;

    while (queue.length) {
      const c  = queue.shift();
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
        seen.add(nk);
        prev.set(nk, c);
        queue.push(n);
      }
    }

    return bestCell ? this._reconstruct(prev, bestCell) : null;
  }

  // Collision-free reachability — decides whether a mission is permanently
  // impossible (→ park). Ignores other vehicles so temporary blocking never
  // sends a truck to the parking.
  _reachStatic(from, goals) {
    if (!goals || !goals.size) return false;
    if (!this.roads.isRoad(from.gx, from.gy)) return false;
    if (goals.has(key(from.gx, from.gy))) return true;

    const queue = [{ gx: from.gx, gy: from.gy }];
    const seen  = new Set([key(from.gx, from.gy)]);
    while (queue.length) {
      const c = queue.shift();
      for (const n of this._neighbors(c)) {
        const nk = key(n.gx, n.gy);
        if (seen.has(nk)) continue;
        if (goals.has(nk)) return true;
        seen.add(nk);
        queue.push(n);
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

  // One-way road neighbours. Parking cells are omnidirectional.
  // Rules: no U-turn out of the current cell; never enter against a cell's flow.
  _neighbors(c) {
    const cell = this.roads.cells.get(key(c.gx, c.gy));
    const cDir = (cell && !cell.parking) ? cell.dir : null;
    const out  = [];
    for (const [dx, dy] of DIRS) {
      const nx = c.gx + dx;
      const ny = c.gy + dy;
      if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
      if (!this.roads.isRoad(nx, ny)) continue;
      if (cDir && dx === -cDir.dx && dy === -cDir.dy) continue;        // no U-turn
      const nc   = this.roads.cells.get(key(nx, ny));
      const nDir = (nc && !nc.parking) ? nc.dir : null;
      if (nDir && dx === -nDir.dx && dy === -nDir.dy) continue;        // not against flow
      out.push({ gx: nx, gy: ny });
    }
    return out;
  }
}
