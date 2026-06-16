import { describe, it, expect, beforeEach } from 'vitest';
import {
  World, Vehicle, Roads, Autopilot,
  VIEW_W, VIEW_H, COLS, ROWS, DRILL_COST,
} from '../../game/world.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const grid = () => ({ zoneCols: 40, zoneRows: 40, zoneW: 10, zoneH: 10 });

// A straight east-west road on row 10 from x=10..20. `oneway` arrows it east.
function corridor({ oneway = false } = {}) {
  const g = grid();
  const roads = new Roads(g);
  const cells = [];
  for (let x = 10; x <= 20; x++) cells.push({ gx: x, gy: 10, dir: oneway ? { dx: 1, dy: 0 } : null });
  roads.setNetwork(cells);
  const ap = new Autopilot(g, roads, { getBlock() {}, mineBlock() {}, deliver() {} });
  ap.isFree = () => true;
  return { g, roads, ap };
}

function fakeTruck(gx, gy) {
  return { gx, gy, tgx: gx, tgy: gy, fromGx: gx, fromGy: gy, moving: false, type: 'oht', load: 0 };
}
function registerTruck(ap, t) {
  ap.links.set(t, {});
  ap.state.set(t, { phase: 'x', dir: null, timer: 0, bucket: 0, stuck: 0, want: null, yield: null });
}

// ── Vehicle ───────────────────────────────────────────────────────────────────

describe('Vehicle', () => {
  const g = grid();

  it('assigns speed and road-only by type', () => {
    const oht = new Vehicle({ type: 'oht', label: 'T', gx: 0, gy: 0, len: 14, wid: 7 });
    const exc = new Vehicle({ type: 'excavator', label: 'E', gx: 0, gy: 0, len: 12, wid: 9 });
    const lv = new Vehicle({ type: 'pickup', label: 'L', gx: 0, gy: 0, len: 9, wid: 5 });
    expect(oht.roadOnly).toBe(true);
    expect(exc.roadOnly).toBe(false);
    expect(lv.roadOnly).toBe(false);
    // excavator is the slowest, light vehicle the fastest
    expect(exc.speed).toBeLessThan(oht.speed);
    expect(oht.speed).toBeLessThan(lv.speed);
  });

  it('places itself at the centre of its cell', () => {
    const v = new Vehicle({ type: 'pickup', label: 'L', gx: 5, gy: 3, len: 9, wid: 5 });
    v.place(g);
    expect(v.x).toBe(5.5 * g.zoneW);
    expect(v.y).toBe(3.5 * g.zoneH);
  });

  it('starts a move toward dir and records the cell left behind', () => {
    const v = new Vehicle({ type: 'pickup', label: 'L', gx: 5, gy: 5, len: 9, wid: 5 });
    v.place(g);
    v.update(0.01, [1, 0], g, () => true, () => true);
    expect(v.moving).toBe(true);
    expect(v.tgx).toBe(6);
    expect(v.fromGx).toBe(5);
    expect(v.heading).toBeCloseTo(0);
  });

  it('reaches the target cell once enough time has passed', () => {
    const v = new Vehicle({ type: 'pickup', label: 'L', gx: 5, gy: 5, len: 9, wid: 5 });
    v.place(g);
    v.update(0.01, [1, 0], g, () => true, () => true); // begin move
    for (let i = 0; i < 100 && v.moving; i++) v.update(0.1, null, g, () => true, () => true); // coast, no new move
    expect(v.gx).toBe(6);
    expect(v.moving).toBe(false);
  });

  it('road-only trucks cannot leave the road', () => {
    const v = new Vehicle({ type: 'oht', label: 'T', gx: 5, gy: 5, len: 14, wid: 7 });
    v.place(g);
    v.update(0.01, [1, 0], g, () => false, () => true); // next cell is not road
    expect(v.moving).toBe(false);
    expect(v.tgx).toBe(5);
  });

  it('manual driving overrides the road-only restriction', () => {
    const v = new Vehicle({ type: 'oht', label: 'T', gx: 5, gy: 5, len: 14, wid: 7 });
    v.place(g);
    v.manual = true;
    v.update(0.01, [1, 0], g, () => false, () => true);
    expect(v.moving).toBe(true);
  });

  it('does not move into an occupied cell', () => {
    const v = new Vehicle({ type: 'pickup', label: 'L', gx: 5, gy: 5, len: 9, wid: 5 });
    v.place(g);
    v.update(0.01, [1, 0], g, () => true, () => false); // nothing is free
    expect(v.moving).toBe(false);
  });

  it('reports occupied cells including the target while moving', () => {
    const v = new Vehicle({ type: 'oht', label: 'T', gx: 5, gy: 5, len: 20, wid: 7 }); // 2 cells long
    v.place(g);
    const idle = v.occupiedCells(g);
    expect(idle.length).toBeGreaterThanOrEqual(1);
    v.update(0.01, [1, 0], g, () => true, () => true);
    expect(v.occupiedCells(g).length).toBeGreaterThan(idle.length);
  });
});

// ── Roads ─────────────────────────────────────────────────────────────────────

describe('Roads', () => {
  it('serializes drawn roads but never parking pads', () => {
    const roads = new Roads(grid());
    roads.addParking(0, 0, 2, 2);
    roads.setNetwork([{ gx: 5, gy: 5, dir: { dx: 1, dy: 0 } }]);
    const out = roads.serialize();
    expect(out).toEqual([{ gx: 5, gy: 5, dir: { dx: 1, dy: 0 } }]);
    expect(roads.isRoad(0, 0)).toBe(true);   // parking still counts as road
  });

  it('setNetwork replaces roads but keeps parking intact', () => {
    const roads = new Roads(grid());
    roads.addParking(0, 0, 2, 2);
    roads.setNetwork([{ gx: 5, gy: 5 }]);
    roads.setNetwork([{ gx: 7, gy: 7 }]);
    expect(roads.isRoad(5, 5)).toBe(false);
    expect(roads.isRoad(7, 7)).toBe(true);
    expect(roads.isRoad(0, 0)).toBe(true);
  });

  it('ignores a malformed payload instead of wiping the network', () => {
    const roads = new Roads(grid());
    roads.setNetwork([{ gx: 5, gy: 5 }]);
    roads.setNetwork(null);            // garbage
    roads.setNetwork('not-an-array');  // garbage
    expect(roads.isRoad(5, 5)).toBe(true);
    roads.setNetwork([{ gx: 1.5, gy: 2 }]); // non-integer coords dropped
    expect(roads.serialize()).toEqual([]);
  });
});

// ── Autopilot pathfinding ───────────────────────────────────────────────────

describe('Autopilot — distance field', () => {
  it('computes correct shortest distances along a corridor', () => {
    const { ap } = corridor();
    const field = ap._distField(new Set(['20,10']), 'g');
    for (let x = 10; x <= 20; x++) expect(field.get(`${x},10`)).toBe(20 - x);
  });

  it('caches a field by id and clears it on demand', () => {
    const { ap } = corridor();
    const a = ap._distField(new Set(['20,10']), 'g');
    const b = ap._distField(new Set(['20,10']), 'g');
    expect(a).toBe(b);                       // same cached instance
    ap._distCache.clear();
    expect(ap._distField(new Set(['20,10']), 'g')).not.toBe(a);
  });

  it('respects one-way flow (cannot reach a goal against the arrows)', () => {
    const { ap } = corridor({ oneway: true }); // arrows point east
    const wrong = ap._distField(new Set(['10,10']), 'w'); // goal at the west end
    expect(wrong.size).toBe(1);              // only the goal itself can reach it
    const right = ap._distField(new Set(['20,10']), 'r'); // goal at the east end
    expect(right.size).toBe(11);             // everything reaches it
  });

  it('_neighbors never steps against a one-way arrow', () => {
    const { ap } = corridor({ oneway: true });
    const fwd = ap._neighbors({ gx: 15, gy: 10 }).map((n) => `${n.gx},${n.gy}`);
    expect(fwd).toContain('16,10');          // with the flow
    expect(fwd).not.toContain('14,10');      // against the flow
  });

  it('_bayCells returns road cells orthogonally adjacent to a block', () => {
    const g = grid();
    const roads = new Roads(g);
    // a block at sub-zones (10..11, 10..11) with one road cell directly above it
    roads.setNetwork([{ gx: 10, gy: 9 }, { gx: 12, gy: 12 }]);
    const ap = new Autopilot(g, roads, {});
    const bays = ap._bayCells(10, 10, 11, 11);
    expect(bays.has('10,9')).toBe(true);     // adjacent above
    expect(bays.has('12,12')).toBe(false);   // not adjacent
  });
});

describe('Autopilot — _advance descent', () => {
  it('descends straight to the goal without ever reversing', () => {
    const { ap } = corridor();
    const t = fakeTruck(10, 10);
    registerTruck(ap, t);
    const goals = new Set(['20,10']);
    const visited = [10];
    for (let i = 0; i < 40 && t.gx < 20; i++) {
      const a = ap._advance(t, goals, 'g', null);
      if (a.arrived || !a.dir) break;
      t.fromGx = t.gx; t.fromGy = t.gy;
      t.gx += a.dir[0]; t.gy += a.dir[1];
      visited.push(t.gx);
    }
    expect(t.gx).toBe(20);
    // strictly increasing → no oscillation
    expect(visited.every((v, i) => i === 0 || v > visited[i - 1])).toBe(true);
  });

  it('reports arrival when already on a goal cell', () => {
    const { ap } = corridor();
    const t = fakeTruck(20, 10);
    registerTruck(ap, t);
    const a = ap._advance(t, new Set(['20,10']), 'g', null);
    expect(a).toEqual({ arrived: true, dir: null });
  });

  it('waits (never reverses) when the only forward step is blocked', () => {
    const { ap } = corridor();
    ap.isFree = (gx, gy) => !(gx === 11 && gy === 10); // 11,10 permanently blocked
    const t = fakeTruck(10, 10);
    registerTruck(ap, t);
    const decisions = [];
    for (let i = 0; i < 10; i++) decisions.push(ap._advance(t, new Set(['20,10']), 'g', null).dir);
    expect(decisions.every((d) => d === null)).toBe(true); // always wait, never back up
  });

  it('takes a free detour around a blockage when the network offers one', () => {
    const g = grid();
    const roads = new Roads(g);
    // two parallel rows joined at both ends → a loop with an alternate path
    const cells = [];
    for (let x = 10; x <= 14; x++) { cells.push({ gx: x, gy: 10 }); cells.push({ gx: x, gy: 11 }); }
    roads.setNetwork(cells);
    const ap = new Autopilot(g, roads, {});
    ap.isFree = (gx, gy) => !(gx === 11 && gy === 10); // block the direct row
    const t = fakeTruck(10, 10);
    registerTruck(ap, t);
    const goals = new Set(['14,10']);
    let steps = 0;
    for (; steps < 50 && !(t.gx === 14 && t.gy === 10); steps++) {
      const a = ap._advance(t, goals, 'g', null);
      if (!a.dir) continue;
      t.fromGx = t.gx; t.fromGy = t.gy;
      t.gx += a.dir[0]; t.gy += a.dir[1];
    }
    expect(t.gx).toBe(14);
    expect(t.gy).toBe(10); // arrived despite the blocked direct cell
  });
});

describe('Autopilot — head-on deadlock', () => {
  function headOn(withPocket) {
    const g = grid();
    const roads = new Roads(g);
    const cells = [];
    for (let x = 10; x <= 20; x++) cells.push({ gx: x, gy: 10 });
    if (withPocket) cells.push({ gx: 15, gy: 11 }); // a passing pocket
    roads.setNetwork(cells);
    const ap = new Autopilot(g, roads, {});
    const A = fakeTruck(11, 10), B = fakeTruck(19, 10);
    registerTruck(ap, A); registerTruck(ap, B);
    ap._rankOf(A); ap._rankOf(B);
    const all = [A, B];
    ap.isFree = (gx, gy, self) => !all.some((v) => v !== self && v.gx === gx && v.gy === gy);
    const goalA = new Set(['20,10']), goalB = new Set(['10,10']);
    const tick = () => {
      ap._distCache.clear();
      for (const [t, goal, id] of [[A, goalA, 'a'], [B, goalB, 'b']]) {
        const st = ap.state.get(t); st.want = null;
        st.dir = st.yield ? ap._yieldStep(t, st) : ap._advance(t, goal, id, null).dir;
      }
      ap._resolveDeadlocks(new Map([[A, ap.state.get(A).dir], [B, ap.state.get(B).dir]]));
      for (const t of all) {
        const d = ap.state.get(t).dir;
        if (d && ap.isFree(t.gx + d[0], t.gy + d[1], t)) { t.fromGx = t.gx; t.fromGy = t.gy; t.gx += d[0]; t.gy += d[1]; }
      }
    };
    return { A, B, tick };
  }

  it('resolves a head-on when a passing pocket exists', () => {
    const { A, B, tick } = headOn(true);
    let resolved = false;
    for (let i = 0; i < 400 && !resolved; i++) { tick(); resolved = A.gx === 20 && B.gx === 10; }
    expect(resolved).toBe(true);
  });

  it('a one-lane dead-end jams statically (no back-and-forth jitter)', () => {
    const { A, B, tick } = headOn(false);
    const trail = [];
    for (let i = 0; i < 200; i++) { tick(); trail.push(`${A.gx},${A.gy}|${B.gx},${B.gy}`); }
    // it never resolves, but the last many ticks are identical → a static jam
    const tail = trail.slice(-20);
    expect(new Set(tail).size).toBe(1);
  });
});

// ── World construction & economy ────────────────────────────────────────────

describe('World — setup & snapshots', () => {
  let w;
  beforeEach(() => { w = new World(); });

  it('exposes sane view constants', () => {
    expect(VIEW_W).toBeGreaterThan(0);
    expect(VIEW_H).toBeGreaterThan(0);
    expect(COLS).toBeGreaterThan(0);
    expect(ROWS).toBeGreaterThan(0);
  });

  it('builds the default fleet and starting credit', () => {
    const state = w.fullState();
    expect(state.credit).toBe(100000);
    expect(state.vehicles.length).toBe(9); // 1 LV + 4 shovels + 4 trucks
    expect(state.vehicles.filter((v) => v.type === 'oht').length).toBe(4);
    expect(state.crushers.length).toBeGreaterThan(0);
    expect(state.roads).toEqual([]); // only parking exists, which is excluded
  });

  it('hides unexplored block composition in snapshots', () => {
    const state = w.fullState();
    const anyHidden = state.blocks.flat().some((b) => b.explored === false && b.ore === undefined);
    expect(anyHidden).toBe(true);
  });
});

describe('World — drilling', () => {
  let w;
  beforeEach(() => { w = new World(); });

  it('charges DRILL_COST and reveals the block', () => {
    const before = w.credit;
    const r = w.drill(5, 5);
    expect(r.block.explored).toBe(true);
    expect(w.credit).toBe(before - DRILL_COST);
  });

  it('is free (no double charge) on an already-explored block', () => {
    w.drill(5, 5);
    const mid = w.credit;
    const r = w.drill(5, 5);
    expect(r.block.explored).toBe(true);
    expect(w.credit).toBe(mid);
  });

  it('rejects out-of-bounds coordinates', () => {
    const r = w.drill(-1, 0);
    expect(r.error).toBe('invalid coordinates');
  });

  it('rejects drilling with insufficient credit', () => {
    w.credit = DRILL_COST - 1;
    const r = w.drill(9, 9);
    expect(r.error).toBe('insufficient credit');
    expect(w.mine.blocks[9][9].explored).toBe(false);
  });
});

describe('World — shop, assignment, manual control', () => {
  let w;
  beforeEach(() => { w = new World(); });

  it('buys an asset, charges its price and spawns it', () => {
    const before = w.vehicles.length;
    const r = w.buyAsset('T264');
    expect(r.ok).toBe(true);
    expect(w.vehicles.length).toBe(before + 1);
    expect(w.credit).toBe(100000 - 100000); // T264 costs exactly the starting credit
  });

  it('rejects an unknown asset id', () => {
    expect(w.buyAsset('NOPE').error).toBe('unknown');
  });

  it('rejects a purchase it cannot afford', () => {
    w.credit = 10;
    expect(w.buyAsset('T264').error).toBe('credit');
  });

  it('assigns a truck to a shovel and clears the link with null', () => {
    w.assign('OHT01', 'HEX01');
    expect(w.autopilot.assignedShovel(w.byLabel.get('OHT01')).label).toBe('HEX01');
    w.assign('OHT01', null);
    expect(w.autopilot.assignedShovel(w.byLabel.get('OHT01'))).toBeNull();
  });

  it('ignores assigning a non-truck', () => {
    w.assign('HEX01', 'HEX02'); // shovels are not haulers
    expect(w.autopilot.assignedShovel(w.byLabel.get('HEX01'))).toBeNull();
  });

  it('puts a vehicle under manual control and hands it back on release', () => {
    const v = w.byLabel.get('OHT01');
    w.control('OHT01', { dir: [1, 0] });
    expect(v.manual).toBe(true);
    expect(w.autopilot.isManual(v)).toBe(true);
    w.control('OHT01', { release: true });
    expect(v.manual).toBe(false);
    expect(w.autopilot.isManual(v)).toBe(false);
  });
});

describe('World — collisions & live deltas', () => {
  let w;
  beforeEach(() => { w = new World(); });

  it('treats cells occupied by other vehicles as not free', () => {
    const a = w.vehicles[0];
    const free = w._isFree(a.gx, a.gy, w.vehicles[1]); // a occupies its own cell
    expect(free).toBe(false);
    expect(w._isFree(a.gx, a.gy, a)).toBe(true);        // a never blocks itself
  });

  it('sends every vehicle on the first delta, then nothing when idle', () => {
    const first = w.liveDelta();
    expect(first.vehicles.length).toBe(w.vehicles.length);
    expect(w.liveDelta()).toBeNull(); // nothing changed → frame skipped
  });

  it('reports a credit change in the delta', () => {
    w.liveDelta();
    w.credit += 500;
    const d = w.liveDelta();
    expect(d.credit).toBe(w.credit);
  });

  it('setRoads invalidates the autopilot path caches', () => {
    w.autopilot._distCache.set('x', new Map());
    w.autopilot._bayCache = new Map();
    w.setRoads([{ gx: 5, gy: 5 }]);
    expect(w.autopilot._bayCache).toBeNull();
    expect(w.autopilot._distCache.size).toBe(0);
  });

  it('reset regenerates the world and restores starting credit', () => {
    w.credit = 1;
    w.drill(3, 3);
    w.reset();
    expect(w.credit).toBe(100000);
    expect(w.vehicles.length).toBe(9);
  });
});

// ── Full haul cycle (integration) ─────────────────────────────────────────────

describe('World — haul cycle integration', () => {
  // Wire a minimal but complete loop: a rich ore block under HEX01, a crusher a
  // few blocks east, a road corridor above both with a spur to the parking, then
  // run the simulation and assert the truck actually earns money without jitter.
  function setupHaul() {
    const w = new World();
    const { autopilot: ap, roads, grid: g } = w;
    const hex = w.byLabel.get('HEX01');
    const sbx = Math.floor(hex.gx / 2), sby = Math.floor(hex.gy / 2);
    const b = w.mine.blocks[sby][sbx];
    b.explored = true; b.ore = 'gold'; b.orePct = 15; b.oreRemaining = 1e12; b.dirtRemaining = 0;

    const cbx = sbx + 8;
    w.crushers = [{ x: cbx * 2, y: sby * 2, w: 2, h: 2 }];
    roads.setCrushers(w.crushers);
    ap._bayCache = null; ap._distCache.clear();

    const gy = sby * 2 - 1;
    const cells = [];
    for (let gx = 6; gx <= cbx * 2 + 1; gx++) cells.push({ gx, gy, dir: null });
    for (let yy = 5; yy < gy; yy++) cells.push({ gx: 6, gy: yy, dir: null });
    w.setRoads(cells);

    const oht = w.byLabel.get('OHT01');
    oht.gx = 6; oht.gy = gy; oht.tgx = 6; oht.tgy = gy; oht.fromGx = 6; oht.fromGy = gy; oht.moving = false;
    oht.x = (6 + 0.5) * g.zoneW; oht.y = (gy + 0.5) * g.zoneH;
    w.assign('OHT01', 'HEX01');
    return { w, oht };
  }

  it('drives the truck through every phase and earns credit', () => {
    const { w, oht } = setupHaul();
    const start = w.credit;
    const phases = new Set();
    let maxLoad = 0;
    const positions = [];
    for (let i = 0; i < 4000; i++) {
      w.tick(1 / 30);
      const st = w.autopilot.state.get(oht);
      if (st) phases.add(st.phase);
      maxLoad = Math.max(maxLoad, oht.load);
      positions.push(`${oht.gx},${oht.gy}`);
    }
    expect(phases.has('loading')).toBe(true);
    expect(phases.has('dumping')).toBe(true);
    expect(maxLoad).toBe(240);          // truck filled to capacity
    expect(w.credit).toBeGreaterThan(start);

    // no A-B-A-B oscillation across the whole run
    let jitter = 0;
    for (let i = 2; i < positions.length; i++)
      if (positions[i] === positions[i - 2] && positions[i] !== positions[i - 1]) jitter++;
    expect(jitter).toBe(0);
  });

  it('exposes a debug plan for a vehicle when enabled', () => {
    const { w } = setupHaul();
    w.setDebug('OHT01', true);
    w.tick(1 / 30);
    const plan = w.debugPaths().OHT01;
    expect(plan).toBeTruthy();
    expect(Array.isArray(plan.path)).toBe(true);
  });
});

// ── Shovel auto-relocation ────────────────────────────────────────────────────

describe('World — shovel relocation', () => {
  // Strand a shovel on a spent block with a fresh ore block one cell east.
  function setupShovel() {
    const w = new World();
    const hex = w.byLabel.get('HEX01');
    const bx = Math.floor(hex.gx / 2), by = Math.floor(hex.gy / 2);
    const here = w.mine.blocks[by][bx];
    here.explored = true; here.ore = null; here.oreRemaining = 0;
    const next = w.mine.blocks[by][bx + 1];
    next.explored = true; next.ore = 'iron'; next.orePct = 50; next.oreRemaining = 5000;
    return { w, hex, bx, by };
  }

  it('queues a move toward the nearest explored ore block', () => {
    const { w, hex } = setupShovel();
    w.autopilot._updateShovels();
    expect(w.autopilot._shovelMove.has(hex)).toBe(true);
    expect(w.autopilot.dirFor(hex)).toEqual([1, 0]); // step east toward the ore
  });

  it('stays put while still mining its current block', () => {
    const { w, hex, bx, by } = setupShovel();
    const here = w.mine.blocks[by][bx];
    here.ore = 'gold'; here.oreRemaining = 9999; // current block still productive
    w.autopilot._updateShovels();
    expect(w.autopilot._shovelMove.has(hex)).toBe(false);
  });

  it('does not auto-relocate a manually-driven shovel', () => {
    const { w, hex } = setupShovel();
    w.control('HEX01', { dir: [0, 1] });
    w.autopilot._updateShovels();
    expect(w.autopilot._shovelMove.has(hex)).toBe(false);
  });

  it('does not auto-relocate a shovel a client is inspecting', () => {
    const { w, hex } = setupShovel();
    w.select('HEX01', true);
    w.autopilot._updateShovels();
    expect(w.autopilot._shovelMove.has(hex)).toBe(false);
    w.select('HEX01', false);
    w.autopilot._updateShovels();
    expect(w.autopilot._shovelMove.has(hex)).toBe(true);
  });

  it('abandons a relocation when the target block loses its ore', () => {
    const { w, hex, bx, by } = setupShovel();
    w.autopilot._updateShovels();
    expect(w.autopilot._shovelMove.has(hex)).toBe(true);
    w.mine.blocks[by][bx + 1].oreRemaining = 0; // someone else mined it out
    w.autopilot._updateShovels();
    expect(w.autopilot._shovelMove.has(hex)).toBe(false);
  });
});
