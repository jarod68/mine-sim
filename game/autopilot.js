// Haul autopilot: shovel relocation, truck task FSM (to_shovel / load / to_crusher
// / dump / park), shortest-path distance fields, anti-jam (detour / off-road dodge /
// head-on yield). Drives instances handed in via the constructor + hooks.

const { DIRS, BUCKET_TIME, TRUCK_CAP, DUMP_TIME, PARK_RECHECK, STUCK_DETOUR, STUCK_DODGE, DIST_CACHE_MAX, PARK_HEADING, key, padSlots } = require('./constants');

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
    this.graders = new Set();
    this._graderState = new Map();   // grader → { target: "gx,gy" | null }
    // Dozers are driven by the world (vein sweep), but registered here so trucks
    // treat them as priority obstacles to skirt — a dozer must never get stuck
    // behind / box in haul traffic.
    this.dozers = new Set();
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
  addGrader(grader) { if (grader) this.graders.add(grader); }
  addDozer(dozer)   { if (dozer) this.dozers.add(dozer); }

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
    if (this.graders.has(v)) return true;
    return this.links.has(v) || this._shovelMove.has(v);
  }

  dirFor(v) {
    if (this.graders.has(v)) return this._graderStep(v);
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
    this._updateGraders();
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
      if (shovel.broken) { this._shovelMove.delete(shovel); continue; }   // frozen → no relocation
      const move = this._shovelMove.get(shovel);
      if (move) {
        // Re-evaluate the in-progress relocation each tick: stop on arrival, or
        // abandon the trip if the target block lost its ore (e.g. another shovel
        // got there first) so it re-picks a fresh destination below. An "aside" move
        // (pulling off a road while idle) has no ore target — keep it until arrival.
        const arrived = !shovel.moving && shovel.gx === move.gx && shovel.gy === move.gy;
        if (move.aside) {
          if (arrived) this._shovelMove.delete(shovel); else continue;
        } else {
          const tb = this.hooks.getBlock(Math.floor(move.gx / 2), Math.floor(move.gy / 2));
          const targetHasOre = tb && tb.ore && tb.oreRemaining > 0;
          if (arrived || !targetHasOre) this._shovelMove.delete(shovel); else continue;
        }
      }
      // Don't auto-relocate a shovel the player is driving or inspecting.
      if (this._manual.has(shovel) || this._selected.has(shovel)) continue;
      if (shovel.digging) continue;
      const bx = Math.floor(shovel.gx / 2);
      const by = Math.floor(shovel.gy / 2);
      const here = this.hooks.getBlock(bx, by);
      // Productive only on an explored block that still has ore → keep mining.
      if (here && here.explored && here.ore && here.oreRemaining > 0) continue;
      // Otherwise relocate to the best EXPLORED ore block, onto a sub-zone where
      // the shovel's body clears every surrounding road AND trucks can still come
      // alongside. A shovel NEVER settles on a road: rather than relaxing that
      // constraint we widen the search, and if no clean spot exists it stays put
      // (pulling aside below if it idles on tarmac).
      const next = this._bestOreInRadius(shovel, bx, by, 3)
                || this._bestOreInRadius(shovel, bx, by, 6);
      if (next) { this._shovelMove.set(shovel, next.place); continue; }
      // Nothing to dig. If it's idle ON a road, pull it off to the side so it stops
      // blocking traffic; otherwise just sit where it is.
      const aside = this._shovelAsideTarget(shovel);
      if (aside) this._shovelMove.set(shovel, aside);
    }
  }

  // For an idle shovel sitting ON a road: the nearest sub-zone where its whole body
  // clears the tarmac, so it parks aside instead of blocking a lane. Null if it's
  // already off the road (or no clear spot is free). Returns { gx, gy, aside:true }.
  _shovelAsideTarget(shovel) {
    if (this._footprintRoadCount(shovel, shovel.gx, shovel.gy) === 0) return null;   // already clear
    for (let r = 1; r <= 8; r++) {
      let best = null, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = shovel.gx + dx, gy = shovel.gy + dy;
          if (this._footprintRoadCount(shovel, gx, gy) !== 0) continue;       // body must fully clear roads
          if (!this._canOccupy(shovel, gx, gy, 0, 0)) continue;               // and be free
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < bestD) { bestD = d; best = { gx, gy, aside: true }; }
        }
      if (best) return best;
    }
    return null;
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
  // road — taken as the WORST of the two axis-aligned headings, since the shovel
  // may settle facing either way (its drive steps are axis-aligned, see
  // _shovelStep). Infinity if the footprint would leave the map. 0 means the body
  // clears every road whichever way it ends up facing.
  _footprintRoadCount(shovel, gx, gy) {
    let n = 0;
    for (const heading of [0, Math.PI / 2]) {
      let h = 0;
      for (const c of shovel.footprintAt(gx, gy, this.grid, heading)) {
        if (c.gx < 0 || c.gy < 0 || c.gx >= this.grid.zoneCols || c.gy >= this.grid.zoneRows) return Infinity;
        if (this.roads.isRoad(c.gx, c.gy)) h++;
      }
      n = Math.max(n, h);
    }
    return n;
  }

  // A sub-zone of block (bx,by) where the shovel can sit. Prefers the cell matching
  // its current parity. The body must fully clear every road (a shovel never blocks
  // a lane) AND leave at least one open cell against it for a truck to dock —
  // otherwise the spot is worthless and we keep looking. Returns { gx, gy } | null.
  _shovelPlacement(shovel, bx, by) {
    const xs = (shovel.gx % 2) === 0 ? [0, 1] : [1, 0];
    const ys = (shovel.gy % 2) === 0 ? [0, 1] : [1, 0];
    for (const oy of ys)
      for (const ox of xs) {
        const gx = bx * 2 + ox;
        const gy = by * 2 + oy;
        if (this._footprintRoadCount(shovel, gx, gy) !== 0) continue;   // body fully off the roads
        if (!this._placeAccessible(shovel, gx, gy)) continue;           // trucks must be able to come
        return { gx, gy };
      }
    return null;
  }

  // Can a truck come alongside the shovel's body centred on (gx,gy)? True when at
  // least one in-bounds cell orthogonally touching the footprint is not a crusher
  // cell — i.e. there is somewhere to dock/load from. Rejects placements jammed
  // into a map corner or against a crusher, which trucks could never service.
  _placeAccessible(shovel, gx, gy) {
    const occ = new Set(shovel.footprintAt(gx, gy, this.grid).map((c) => key(c.gx, c.gy)));
    const onCrusher = (nx, ny) => (this.roads.crushers || []).some(
      (cr) => nx >= cr.x && nx < cr.x + cr.w && ny >= cr.y && ny < cr.y + cr.h);
    for (const cstr of occ) {
      const [cx, cy] = cstr.split(',').map(Number);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
        if (occ.has(key(nx, ny)) || onCrusher(nx, ny)) continue;
        return true;
      }
    }
    return false;
  }

  // Best EXPLORED ore block within `R` blocks (Chebyshev) of (bx,by) for `shovel`
  // to move to. Never reveals undrilled ground, never a block on a road, and only
  // blocks where a road-clear, truck-accessible placement exists for this shovel's
  // body. Priority: road access first, then nearest, then richest. Returns
  // { bx, by, place } | null.
  _bestOreInRadius(shovel, bx, by, R) {
    // Blocks another shovel already works or is relocating to — two shovels must
    // never stack onto the same ore block (they'd fight over it and jam traffic).
    const claimed = new Set();
    for (const s of this.shovels) {
      if (s === shovel) continue;
      const sb = this._shovelBlock(s);
      claimed.add(`${sb.bx},${sb.by}`);
    }
    let best = null;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nbx = bx + dx;
        const nby = by + dy;
        if (claimed.has(`${nbx},${nby}`)) continue;       // another shovel's block
        const b = this.hooks.getBlock(nbx, nby);
        if (!(b && b.explored && b.ore && b.oreRemaining > 0)) continue;
        if (this._blockOnRoad(nbx, nby)) continue;        // never sit on a road
        const place = this._shovelPlacement(shovel, nbx, nby);
        if (!place) continue;                            // body would straddle a road / be unreachable
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

  // ── grader auto-repair ───────────────────────────────────────────────────────
  // Idle graders patrol the map and smooth out degraded roads on their own. Each
  // grader is given the nearest worn cell that another grader isn't already heading
  // for (so several graders fan out to different areas); the cell is repaired the
  // moment the grader drives onto it (world tick). With no worn road left, graders
  // return to the parking pad and wait.
  _updateGraders() {
    if (!this.graders.size) return;
    const worn = this.roads.wornKeys();
    // Hold onto every still-valid target so we don't reassign a grader mid-trip and
    // so other graders steer clear of cells already being serviced.
    const claimed = new Set();
    for (const g of this.graders) {
      if (this._manual.has(g)) continue;
      const st = this._graderState.get(g);
      if (st && st.target && worn.has(st.target)) claimed.add(st.target);
    }
    for (const g of this.graders) {
      if (this._manual.has(g)) { this._graderState.delete(g); continue; }
      let st = this._graderState.get(g);
      if (!st) { st = { target: null }; this._graderState.set(g, st); }
      if (!(st.target && worn.has(st.target))) {     // need a fresh target
        const next = this._pickGraderTarget(g, worn, claimed);
        if (next !== st.target) st.stuck = 0;        // new destination → reset progress
        st.target = next;
        if (st.target) claimed.add(st.target);
      }
    }
  }

  // Road distance from the grader to every reachable cell (forward BFS, one-way
  // aware) — so it can pick the worn cell that's genuinely SHORTEST to drive to,
  // not just nearest as the crow flies. Null when the grader is off the network.
  _graderReach(grader) {
    const a = this._logical(grader);
    if (!this.roads.isRoad(a.gx, a.gy)) return null;
    const dist = new Map([[key(a.gx, a.gy), 0]]);
    const q = [a];
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      const d = dist.get(key(c.gx, c.gy));
      for (const n of this._neighbors(c)) {              // successors respect one-way flow
        const nk = key(n.gx, n.gy);
        if (dist.has(nk)) continue;
        dist.set(nk, d + 1);
        q.push(n);
      }
    }
    return dist;
  }

  // The worn cell SHORTEST to reach by road (one-way aware), that another grader
  // isn't already heading for. Cells ≥ SPREAD from every claimed cell are preferred
  // (graders fan out to distinct areas); unclaimed cells inside a claimed area are
  // the fallback (several graders may share one big cluster, but never one cell).
  // With every worn cell claimed, returns null — the spare grader goes and rests
  // at the pad instead of stacking onto a colleague's job. Off-network/unreachable
  // cells fall back to crow-flies distance, ranked after every reachable one.
  _pickGraderTarget(grader, worn, claimed) {
    if (!worn.size) return null;
    const a = this._logical(grader);
    const reach = this._graderReach(grader);
    const distOf = (gx, gy) => {
      const r = reach && reach.get(key(gx, gy));
      return r != null ? r : 1e6 + Math.abs(a.gx - gx) + Math.abs(a.gy - gy);
    };
    const SPREAD = 10;
    let best = null, bestD = Infinity;     // unclaimed, clear of every claimed area
    let spare = null, spareD = Infinity;   // unclaimed, but inside a claimed area
    for (const wk of worn) {
      if (claimed.has(wk)) continue;                   // exact cell already owned
      const [gx, gy] = wk.split(',').map(Number);
      const d = distOf(gx, gy);
      let clear = true;
      for (const ck of claimed) {
        const [cx, cy] = ck.split(',').map(Number);
        if (Math.abs(cx - gx) + Math.abs(cy - gy) < SPREAD) { clear = false; break; }
      }
      if (clear) { if (d < bestD) { bestD = d; best = wk; } }
      else if (d < spareD) { spareD = d; spare = wk; }
    }
    return best || spare;
  }

  // The goal cell-set (+ a representative point) for a grader: its worn-cell target,
  // or the whole parking pad when there's nothing to repair.
  _graderGoals(grader) {
    const st = this._graderState.get(grader);
    if (st && st.target) {
      const [gx, gy] = st.target.split(',').map(Number);
      return { goals: new Set([st.target]), gid: `GR:${st.target}`, point: { gx, gy } };
    }
    const goals = new Set();
    for (const p of this.roads.parkings || [])
      for (let gy = p.y; gy < p.y + p.h; gy++)
        for (let gx = p.x; gx < p.x + p.w; gx++) goals.add(key(gx, gy));
    return { goals, gid: 'GRP', point: this._nearestFreeParkingCell(grader) };
  }

  // A grader drives ON the road network, FOLLOWING the one-way flow, to its target by
  // the shortest route. When boxed in, or while off the tarmac, it routes AROUND the
  // obstacle (flow-safe BFS) back onto the network — it never drives the wrong way and
  // never just stalls. It has right of way: a truck on the cell it needs is asked to
  // pull aside (see _requestGiveWay) but the grader doesn't wait on it.
  _graderStep(grader) {
    const st = this._graderState.get(grader);
    if (!st) return null;
    const { goals, gid, point } = this._graderGoals(grader);
    if (!goals.size || !point) return null;
    const lc = this._logical(grader);
    if (goals.has(key(lc.gx, lc.gy))) { st.stuck = 0; return null; }   // arrived
    const field = this._distField(goals, gid);
    const dC = this.roads.isRoad(lc.gx, lc.gy) ? field.get(key(lc.gx, lc.gy)) : null;

    // On the network and the goal is reachable along the flow → descend the road.
    if (dC != null) {
      // Among one-way-respecting successors, keep ROLLING: a free strictly-closer cell
      // (prog), else a free equal-distance lane, else a free longer way round (detour,
      // never an immediate U-turn). All flow-legal — never against an arrow.
      let prog = null, progD = Infinity, lane = null, detour = null, detourD = Infinity, blocker = null;
      for (const n of this._neighbors(lc)) {
        const dn = field.get(key(n.gx, n.gy));
        if (dn == null) continue;
        const free = this._canOccupy(grader, n.gx, n.gy, n.gx - lc.gx, n.gy - lc.gy);
        if (dn < dC) {
          if (!free) { if (!blocker) blocker = n; continue; }
          if (dn < progD) { progD = dn; prog = n; }
        } else if (!free) continue;
        else if (n.gx === grader.fromGx && n.gy === grader.fromGy) continue;   // no immediate U-turn
        else if (dn === dC) { if (!lane) lane = n; }
        else if (dn < detourD) { detourD = dn; detour = n; }
      }
      const pick = prog || lane || detour;
      if (pick) { st.stuck = 0; st.skirtRef = null; return [pick.gx - lc.gx, pick.gy - lc.gy]; }
      // Boxed in on a single-corridor obstacle. Ask a truck to pull aside (priority),
      // but don't wait — route AROUND the blocker off-road to a foothold PAST it
      // (closer to the goal than here, so it never just loops back).
      if (blocker) {
        const t = this._stationaryTruckAt(blocker.gx, blocker.gy, grader);
        if (t) this._requestGiveWay(t, lc);
        if ((st.stuck = (st.stuck || 0) + 1) >= 2) {
          st.skirtRef = dC;
          const step = this._graderRouteStep(grader, field, dC);
          if (step) { st.stuck = 0; return step; }
        }
      }
      return null;
    }

    // Off the network (or on a road the target can't be reached from): route back onto
    // the network toward the goal, AROUND any obstacle. While mid-skirt the foothold
    // must beat the distance we got stuck at; otherwise any reachable road cell will do.
    const ref = st.skirtRef != null ? st.skirtRef : Infinity;
    const step = this._graderRouteStep(grader, field, ref);
    if (step) { st.stuck = 0; return step; }
    st.skirtRef = null;
    const aim = this.roads.isRoad(lc.gx, lc.gy) ? point : (this._nearestRoadCell(grader) || point);
    return this._graderOffroadStep(grader, aim);
  }

  // Like _offroadStep, but a grader NEVER enters a road cell against its one-way
  // arrow — so while skirting / approaching the network off-road it can't end up
  // driving the wrong way down a lane.
  _graderOffroadStep(grader, target) {
    const a = this._logical(grader);
    let best = null, bestD = Math.abs(target.gx - a.gx) + Math.abs(target.gy - a.gy);
    if (bestD === 0) return null;
    for (const [dx, dy] of DIRS) {
      const nx = a.gx + dx, ny = a.gy + dy;
      if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
      const c = this.roads.cells.get(key(nx, ny));
      if (c && !c.parking && c.dir && dx === -c.dir.dx && dy === -c.dir.dy) continue;   // not against the flow
      const d = Math.abs(target.gx - nx) + Math.abs(target.gy - ny);
      if (d < bestD && this._canOccupy(grader, nx, ny, dx, dy)) { bestD = d; best = [dx, dy]; }
    }
    return best;
  }

  // A bounded, flow-safe BFS over free cells (off-road allowed) to the nearest road
  // FOOTHOLD — a cell reachable to the goal on `field`, and strictly closer than the
  // grader's current cell when it's already on the field (so it makes progress past a
  // blocker). Returns the first step of that detour. Unlike a monotonic step it can
  // route AROUND an obstacle sitting directly in the way, so the grader never stalls
  // or loops. Used both to skirt an on-road blocker and to climb back onto the network
  // from off-road.
  _graderRouteStep(grader, field, ref) {
    const a = this._logical(grader);
    // A foothold must be closer to the goal than `ref` (the distance the grader is
    // trying to beat) — so it heads PAST a blocker, never back onto the stuck cell.
    const limit = ref != null ? ref : (field.get(key(a.gx, a.gy)) ?? Infinity);
    const parent = new Map([[key(a.gx, a.gy), null]]);
    const q = [a];
    const R = 16;
    let foothold = null;
    for (let h = 0; h < q.length && !foothold; h++) {
      const c = q[h];
      for (const [dx, dy] of DIRS) {
        const nx = c.gx + dx, ny = c.gy + dy;
        if (nx < 0 || ny < 0 || nx >= this.grid.zoneCols || ny >= this.grid.zoneRows) continue;
        if (Math.abs(nx - a.gx) + Math.abs(ny - a.gy) > R) continue;
        const nk = key(nx, ny);
        if (parent.has(nk)) continue;
        const rc = this.roads.cells.get(nk);
        if (rc && !rc.parking && rc.dir && dx === -rc.dir.dx && dy === -rc.dir.dy) continue;   // not against the flow
        if (!this._canOccupy(grader, nx, ny, dx, dy)) continue;
        parent.set(nk, c);
        const fd = field.get(nk);
        // A real foothold: a road cell closer to the goal than `limit` that the grader
        // can actually CARRY ON from (a free, closer forward neighbour) — so it lands
        // past the obstacle, not jammed against it.
        if (fd != null && fd < limit && this.roads.isRoad(nx, ny) && this._graderCanProceed(grader, nx, ny, fd, field)) {
          foothold = { gx: nx, gy: ny }; break;
        }
        q.push({ gx: nx, gy: ny });
      }
    }
    if (!foothold) return null;
    let c = foothold, par = parent.get(key(c.gx, c.gy));
    while (par && !(par.gx === a.gx && par.gy === a.gy)) { c = par; par = parent.get(key(c.gx, c.gy)); }
    return [c.gx - a.gx, c.gy - a.gy];
  }

  // Can the grader carry on toward the goal from road cell (gx,gy)? — i.e. is there a
  // free, strictly-closer forward neighbour (one-way aware)? Used to reject footholds
  // that are nearer the goal but still jammed against the obstacle.
  _graderCanProceed(grader, gx, gy, fd, field) {
    for (const n of this._neighbors({ gx, gy })) {
      const dn = field.get(key(n.gx, n.gy));
      if (dn != null && dn < fd && this._canOccupy(grader, n.gx, n.gy, n.gx - gx, n.gy - gy)) return true;
    }
    return false;
  }

  // The grader (priority) needs the cell this stationary truck sits on — flag the
  // truck to pull aside off the lane until the grader has passed. Skipped for a truck
  // mid load/dump/dock (committed) or already yielding to another truck.
  _requestGiveWay(truck, from) {
    const st = this.state.get(truck);
    if (!st || st.yield) return;
    if (st.phase === 'loading' || st.phase === 'dumping' || st.phase === 'docking' || st.phase === 'undocking') return;
    st.giveWay = st.giveWay || { fromGx: from.gx, fromGy: from.gy };
    st.giveWay.fromGx = from.gx; st.giveWay.fromGy = from.gy;
    st.giveWay.ticks = 0;                                 // refreshed each tick the grader still waits
  }

  // Drive a truck asked to give way to a grader: pull to the side off the road to
  // clear the lane, hold there until the grader has gone by (the request stops being
  // refreshed for a few ticks), then resume its run.
  _tickGiveWay(truck, st) {
    truck.task = null;
    st.want = null;
    if ((st.giveWay.ticks = (st.giveWay.ticks || 0) + 1) > 10) {   // grader passed / gone
      st.giveWay = null; truck.offroad = false; st.dir = null; st.stuck = 0; return;
    }
    if (truck.moving) return;                              // finish the current hop
    const a = this._logical(truck);
    if (!this.roads.isRoad(a.gx, a.gy)) { st.dir = null; return; }   // already clear of the lane → hold
    const axis = [a.gx - st.giveWay.fromGx, a.gy - st.giveWay.fromGy];
    const side = this._sideStepOff(truck, a, axis);
    if (side) { truck.offroad = true; st.dir = side; return; }
    st.dir = null;                                         // boxed in — hold; the grader skirts
  }

  // Closest parking-pad cell this grader can occupy — its resting spot when no road
  // needs repair.
  _nearestFreeParkingCell(grader) {
    const a = this._logical(grader);
    let best = null, bestD = Infinity;
    for (const p of this.roads.parkings || [])
      for (let gy = p.y; gy < p.y + p.h; gy++)
        for (let gx = p.x; gx < p.x + p.w; gx++) {
          const d = Math.abs(a.gx - gx) + Math.abs(a.gy - gy);
          if (d >= bestD) continue;
          if (!this._canOccupy(grader, gx, gy, 0, 0)) continue;
          bestD = d; best = { gx, gy };
        }
    return best;
  }

  setSelected(v, on) {
    if (!v) return;
    if (on) this._selected.add(v); else this._selected.delete(v);
  }

  // One AXIS-ALIGNED step of a shovel relocation (never diagonal, so the shovel
  // always settles facing along an axis and its footprint matches what
  // _footprintRoadCount planned for). Longest remaining axis first; if that step
  // is blocked, try the other axis, else wait.
  _shovelStep(shovel) {
    const t = this._shovelMove.get(shovel);
    if (!t) return null;
    const cx = shovel.moving ? shovel.tgx : shovel.gx;
    const cy = shovel.moving ? shovel.tgy : shovel.gy;
    const dx = t.gx - cx;
    const dy = t.gy - cy;
    if (dx === 0 && dy === 0) return null;
    const opts = [];
    if (dx !== 0) opts.push([Math.sign(dx), 0]);
    if (dy !== 0) opts.push([0, Math.sign(dy)]);
    if (opts.length === 2 && Math.abs(dy) > Math.abs(dx)) opts.reverse();
    for (const [mx, my] of opts)
      if (this._canOccupy(shovel, cx + mx, cy + my, mx, my)) return [mx, my];
    return opts[0];   // blocked — keep asking; the obstacle will clear
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
    if (this._manual.has(truck)) { st.dir = null; st.yield = null; st.giveWay = null; st.clearLane = null; return; }
    if (st.yield) { st.dir = this._yieldStep(truck, st); return; }
    if (st.giveWay) { this._tickGiveWay(truck, st); return; }   // pulling aside for a grader
    if (st.clearLane) { this._tickClearLane(truck, st); return; }   // pulling off a gridlocked lane
    if (st.dodge) { this._tickDodge(truck, st); return; }   // skirting a blocking shovel
    const sb = this._shovelBlock(shovel);

    // A road-travel phase assumes the truck is on the network. If it isn't (e.g.
    // the player released it mid-dock), walk it back to the nearest road first —
    // the road autopilot can't route from an off-road cell.
    // A truck deliberately waiting OFF-road beside a full pad is exempt — walking
    // it back onto the network would fight _tickOverflow forever.
    const overflowing = st.phase === 'to_parking' && st.overPark;
    const roadPhase = st.phase === 'to_shovel' || st.phase === 'to_crusher' || st.phase === 'to_parking';
    if (roadPhase && !overflowing && !this.roads.isRoad(truck.gx, truck.gy) && !truck.moving) {
      truck.offroad = true;
      const target = this._nearestRoadCell(truck);
      // Greedy first; when every distance-reducing step is blocked (e.g. two
      // off-road trucks facing each other), fall back to a short BFS that routes
      // AROUND the obstacle — a truck must never stay stranded off the network.
      st.dir = target ? (this._offroadStep(truck, target) || this._dodgeStep(truck, target)) : null;
      return;
    }

    switch (st.phase) {
      case 'loading':    st.dir = null; if (shovel.broken) return; shovel.digging = true; this._doLoad(dt, truck, shovel, sb, st); return;
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
      st.phase = 'loading'; st.timer = 0; st.bucket = 0; truck.load = 0; st.dir = null; st.dockStuck = 0; return;
    }
    const bay = this._shovelDockBay(truck, shovel);
    st.dir = bay ? this._offroadStep(truck, bay) : null;
    // A docking truck HOLDS the shovel lock. If it can't actually reach the
    // shovel (boxed in by the queue), it must not starve everyone else — give
    // the lock back and rejoin the road; another truck takes its turn.
    if (!st.dir && !truck.moving) {
      if ((st.dockStuck = (st.dockStuck || 0) + 1) > 60) {
        this._unlockShovel(shovel, truck);
        st.phase = 'undocking'; st.undockThen = 'to_shovel'; st.dockStuck = 0;
      }
    } else st.dockStuck = 0;
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

  // Closest road cell to the truck (expanding ring, WIDE radius — a truck must
  // never be unrecoverable off-road, wherever a dodge or clear-lane left it).
  // Prefers a cell it can occupy right now; if only busy road cells are near,
  // keeps scanning a few more rings for a free one, then falls back to the
  // nearest busy cell — stepping toward it simply queues until it clears.
  _nearestRoadCell(truck) {
    const a = this._logical(truck);
    let busy = null, busyRing = Infinity;
    for (let r = 1; r <= 40; r++) {
      if (busy && r > busyRing + 3) return busy;   // no free cell near the busy one
      let free = null, freeD = Infinity;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = a.gx + dx, gy = a.gy + dy;
          if (!this.roads.isRoad(gx, gy)) continue;
          const d = Math.abs(dx) + Math.abs(dy);
          if (!busy) { busy = { gx, gy }; busyRing = r; }
          if (d < freeD && this._canOccupy(truck, gx, gy, 0, 0)) { freeD = d; free = { gx, gy }; }
        }
      if (free) return free;
    }
    return busy;
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

  // Every grid cell currently covered by a slow off-road WORKER's body — shovels,
  // dozers and graders. These have priority over haul trucks, which skirt them
  // rather than wait. (Dozers especially must never be blocked by traffic.)
  _shovelCells() {
    const s = new Set();
    const add = (v) => { for (const c of v.footprintAt(v.gx, v.gy, this.grid)) s.add(key(c.gx, c.gy)); };
    for (const sh of this.shovels) add(sh);
    for (const d of this.dozers) add(d);
    for (const g of this.graders) add(g);
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
    if (!st.want) return false;
    const wk = key(st.want.gx, st.want.gy);
    const byWorker = this._shovelCells().has(wk);
    // Skirt a slow priority worker (dozer / grader / shovel) quickly; wait the
    // longer beat before skirting ordinary truck traffic.
    if (st.stuck < (byWorker ? STUCK_DETOUR : STUCK_DODGE)) return false;
    const blockTruck = byWorker ? null : this._stationaryTruckAt(st.want.gx, st.want.gy, truck);
    let sameQueue = false;
    if (blockTruck && !blockTruck.broken) {                  // a broken-down truck is always skirted
      const d = this._queueDest(truck, st);
      sameQueue = !!(d && d === this._queueDest(blockTruck, this.state.get(blockTruck)));
    }
    if (!byWorker && !blockTruck) return false;
    const gridlocked = st.stuck >= STUCK_DODGE * 3;          // jammed far longer than a normal wait
    const lc = this._logical(truck);
    // Skirt forward to a foothold past the obstacle. Same-queue trucks normally wait
    // in line, but once truly gridlocked they break formation to unjam.
    if (!sameQueue || gridlocked) {
      const target = this._dodgeTarget(truck, goals, gid, lc);
      if (target) { st.dodge = { target, fromGx: lc.gx, fromGy: lc.gy, ticks: 0 }; st.stuck = 0; return true; }
    }
    // Gridlocked with no way forward → pull OFF the road to clear the lane so the jam
    // unwinds (anticipating a cascade), then rejoin once the way ahead opens.
    if (gridlocked) {
      const side = this._sideStepOff(truck, lc, [st.want.gx - lc.gx, st.want.gy - lc.gy]);
      if (side) { st.clearLane = { ticks: 0, want: { gx: st.want.gx, gy: st.want.gy } }; st.stuck = 0; }
    }
    return false;
  }

  // Drive a gridlocked truck that has pulled OFF the road to clear the lane: hold to
  // the side until the cell it wanted is free again (the jam ahead moved on) or a
  // timeout, then hand back to the normal autopilot to rejoin.
  _tickClearLane(truck, st) {
    truck.task = null;
    st.want = null;
    const cl = st.clearLane;
    if (this._canOccupy(truck, cl.want.gx, cl.want.gy, 0, 0) || (cl.ticks = (cl.ticks || 0) + 1) > 150) {
      st.clearLane = null; truck.offroad = false; st.dir = null; st.stuck = 0; return;
    }
    if (truck.moving) return;
    const lc = this._logical(truck);
    if (!this.roads.isRoad(lc.gx, lc.gy)) { truck.offroad = true; st.dir = null; return; }   // already off the lane → hold
    const side = this._sideStepOff(truck, lc, [cl.want.gx - lc.gx, cl.want.gy - lc.gy]);
    if (side) { truck.offroad = true; st.dir = side; return; }
    st.dir = null;
  }

  // Nearest free, non-shovel road cell that is strictly closer to the goal than
  // the truck's current cell — i.e. a foothold on the far side of the shovel.
  _dodgeTarget(truck, goals, gid, lc) {
    const field = this._distField(goals, gid);
    const dC = field.get(key(lc.gx, lc.gy));
    if (dC == null) return null;
    const shovelCells = this._shovelCells();
    let best = null, bestScore = Infinity;
    const R = 10;
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
    const pad = 7;
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
        const rc = this.roads.cells.get(k);
        if (rc && !rc.parking && rc.dir && dx === -rc.dir.dx && dy === -rc.dir.dy) continue;   // never the wrong way down a lane
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
    if (!slot) { this._tickOverflow(truck, st); return; }   // pad full → wait beside it
    st.overPark = null;
    const goals = new Set([key(slot.gx, slot.gy)]);
    const gid = `P:${slot.gx},${slot.gy}`;
    const a = this._advance(truck, goals, gid, null);
    if (a.arrived) { st.phase = 'parked'; st.timer = 0; st.dir = null; truck.heading = PARK_HEADING; return; }
    this._advanceTail(truck, goals, gid, st, a);
  }

  // The pad is completely full. Rather than stopping dead on a road (or in the
  // middle of the pad, boxing parked trucks in), the truck pulls OFF the network
  // to a clear spot just outside the pad and waits there nose-up. It keeps
  // re-checking: a freed slot (or a new job, via _redirectIfUseful) resumes it.
  _tickOverflow(truck, st) {
    truck.task = null;
    st.want = null;
    st.dir = null;
    if (truck.moving) return;
    const a = this._logical(truck);
    let t = st.overPark;
    if (!t || !(a.gx === t.gx && a.gy === t.gy) && !this._overflowSpotOk(truck, t.gx, t.gy)) {
      t = st.overPark = this._overflowSpot(truck);
    }
    if (!t) return;                                      // boxed in — hold
    if (a.gx === t.gx && a.gy === t.gy) {                // waiting beside the pad
      truck.offroad = false; truck.heading = PARK_HEADING; return;
    }
    truck.offroad = true;
    st.dir = this._offroadStep(truck, t) || this._dodgeStep(truck, t);
  }

  // Is (gx,gy) still a valid waiting spot for this truck? Whole parked footprint
  // in bounds, off every road and pad, off the crushers, clear of stationary
  // vehicles — and clear of every OTHER waiting truck's claimed footprint (two
  // adjacent spots physically overlap through the rear cell, so claims must
  // exclude by overlap, not by exact cell; claims hold even while the claimant
  // is still driving over, which keeps spot choices stable instead of trucks
  // re-planning against each other every tick).
  _overflowSpotOk(truck, gx, gy, occ = this._stationaryOcc(truck)) {
    const cells = new Set();
    for (const c of truck.collisionCells(gx, gy, this.grid, PARK_HEADING)) {
      if (c.gx < 0 || c.gy < 0 || c.gx >= this.grid.zoneCols || c.gy >= this.grid.zoneRows) return false;
      if (this.roads.isRoad(c.gx, c.gy) || this._onCrusher(c.gx, c.gy)) return false;
      if (occ.has(key(c.gx, c.gy))) return false;
      cells.add(key(c.gx, c.gy));
    }
    for (const [t2, st2] of this.state) {
      if (t2 === truck || !st2.overPark) continue;
      for (const c of t2.collisionCells(st2.overPark.gx, st2.overPark.gy, this.grid, PARK_HEADING))
        if (cells.has(key(c.gx, c.gy))) return false;
    }
    return true;
  }

  // Nearest clear off-road waiting spot (expanding ring around the truck).
  _overflowSpot(truck) {
    const a = this._logical(truck);
    const occ = this._stationaryOcc(truck);
    for (let r = 1; r <= 10; r++) {
      let best = null, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = a.gx + dx, gy = a.gy + dy;
          if (!this._overflowSpotOk(truck, gx, gy, occ)) continue;
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < bestD) { bestD = d; best = { gx, gy }; }
        }
      if (best) return best;
    }
    return null;
  }

  // If the truck can do something useful right now, switch its phase and return
  // true. Loaded → deliver at the crusher; empty → fetch ore from its shovel.
  // Reachability ignores other vehicles so a momentary jam never blocks a redirect.
  // A truck waiting off-road (overflow parking) tests from the nearest road cell —
  // once redirected, the off-road recovery walks it back onto the network.
  _redirectIfUseful(truck, st) {
    let from = this._logical(truck);
    if (!this.roads.isRoad(from.gx, from.gy)) from = this._nearestRoadCell(truck) || from;
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
    const dist = Math.abs(bl.gx - a.gx) + Math.abs(bl.gy - a.gy);
    const adjacent = dist <= 1;
    // Resume when the opponent has passed — but ALSO when it left the area
    // entirely (a positive projection can persist while it drives away along
    // the axis) or after a hard timeout (the opponent may itself be stuck):
    // a yielding truck must never hold its pocket forever.
    y.ticks = (y.ticks || 0) + 1;
    if (proj < 0 || (!adjacent && proj === 0) || dist > 6 || y.ticks > 240) {
      st.yield = null; st.stuck = 0; truck.offroad = false; return null;   // resume
    }
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

  // A free OPEN-GROUND cell perpendicular to the conflict axis the truck can pull
  // into to clear a one-lane stand-off — used instead of reversing against the
  // flow. Never a road cell: pulling "aside" onto a crossing lane makes the next
  // tick sidestep again from there, a runaway march down that lane that sent
  // trucks drifting across the whole map. With no clear ground to either side the
  // truck holds instead.
  _sideStepOff(truck, a, axis) {
    const perp = axis[0] === 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [dx, dy] of perp) {
      const gx = a.gx + dx, gy = a.gy + dy;
      if (gx < 0 || gy < 0 || gx >= this.grid.zoneCols || gy >= this.grid.zoneRows) continue;
      if (this.roads.isRoad(gx, gy)) continue;
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
    // "En bataille" grid: nose-up trucks one column apart (their narrow side),
    // ranks two rows apart, body + rear cell always inside the pad (padSlots),
    // filling the pad in tidy aligned ranks.
    for (const p of this.roads.parkings || []) this._slots.push(...padSlots(p));
  }

  // Cells covered by every STATIONARY vehicle other than `self` — used to test
  // whether a parking slot is genuinely takeable. Moving vehicles are ignored
  // (they'll clear the cell on their own), so a truck merely driving across the
  // pad never makes slot assignments flip-flop.
  _stationaryOcc(self) {
    const set = new Set();
    for (const v of (this.hooks.allVehicles ? this.hooks.allVehicles() : [])) {
      if (v === self || v.moving) continue;
      for (const c of v.occupiedCells(this.grid)) set.add(key(c.gx, c.gy));
    }
    return set;
  }

  // Would `truck`, parked nose-up on (gx,gy), overlap a stationary vehicle?
  _slotClear(truck, gx, gy, occ) {
    for (const c of truck.collisionCells(gx, gy, this.grid, PARK_HEADING))
      if (occ.has(key(c.gx, c.gy))) return false;
    return true;
  }

  _inPad(gx, gy) {
    for (const p of this.roads.parkings || [])
      if (gx >= p.x && gx < p.x + p.w && gy >= p.y && gy < p.y + p.h) return true;
    return false;
  }

  _onCrusher(gx, gy) {
    return (this.roads.crushers || []).some(
      (cr) => gx >= cr.x && gx < cr.x + cr.w && gy >= cr.y && gy < cr.y + cr.h);
  }

  // Every cell a truck parked nose-up on (gx,gy) would reserve (body + rear)
  // lies inside a pad — so a parked truck can never spill onto a road running
  // along the pad's edge and block it.
  _padParkable(truck, gx, gy) {
    for (const c of truck.collisionCells(gx, gy, this.grid, PARK_HEADING))
      if (!this._inPad(c.gx, c.gy)) return false;
    return true;
  }

  // The slot this truck should park on. Sticky once assigned, but re-validated
  // against the real occupancy: a slot squatted by anything stationary (the LV,
  // a resting grader, a manually-parked or broken truck…) is abandoned and the
  // NEAREST free slot is picked instead — the truck never drives into a blocked
  // slot and idles against it. With every formal slot taken, any pad cell whose
  // whole parked footprint fits the pad is used; a genuinely FULL pad returns
  // null and the truck waits beside it (see _tickOverflow).
  _parkSlot(truck) {
    if (!this._slots) this._buildSlots();
    const occ = this._stationaryOcc(truck);
    const cur = this._slotByTruck.get(truck);
    if (cur && this._padParkable(truck, cur.gx, cur.gy) && this._slotClear(truck, cur.gx, cur.gy, occ)) return cur;
    if (cur) this._slotByTruck.delete(truck);          // blocked → repick below
    const taken = new Set([...this._slotByTruck.values()].map((v) => key(v.gx, v.gy)));
    const a = this._logical(truck);
    const pick = (cells) => {
      let best = null, bestD = Infinity;
      for (const s of cells) {
        if (taken.has(key(s.gx, s.gy))) continue;
        if (!this._padParkable(truck, s.gx, s.gy)) continue;
        if (!this._slotClear(truck, s.gx, s.gy, occ)) continue;
        const d = Math.abs(a.gx - s.gx) + Math.abs(a.gy - s.gy);
        if (d < bestD) { bestD = d; best = { gx: s.gx, gy: s.gy }; }
      }
      return best;
    };
    let s = pick(this._slots);
    if (!s) {
      const padCells = [];
      for (const p of this.roads.parkings || [])
        for (let gy = p.y; gy < p.y + p.h; gy++)
          for (let gx = p.x; gx < p.x + p.w; gx++) padCells.push({ gx, gy });
      s = pick(padCells);
    }
    if (s) this._slotByTruck.set(truck, s);
    return s ?? null;
  }

  _releaseSlot(truck) {
    if (this._slotByTruck) this._slotByTruck.delete(truck);
    const st = this.state.get(truck);
    if (st) st.overPark = null;                    // free the waiting spot too
  }

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
