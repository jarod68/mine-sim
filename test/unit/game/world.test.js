import { describe, it, expect, beforeEach } from 'vitest';
import {
  World, Vehicle, Roads, Autopilot,
  VIEW_W, VIEW_H, COLS, ROWS, DRILL_COST,
} from '../../../game/world.js';

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
  // A point-sized truck (single-cell footprint) keeps these pathfinding tests
  // reasoning about one cell at a time; the real multi-cell footprint is covered
  // by the Vehicle.footprintAt tests.
  return {
    gx, gy, tgx: gx, tgy: gy, fromGx: gx, fromGy: gy, moving: false, type: 'oht', load: 0,
    footprintAt(fx, fy) { return [{ gx: fx, gy: fy }]; },
    collisionCells(fx, fy) { return [{ gx: fx, gy: fy }]; },
  };
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

  it('footprintAt covers exactly the cells the body spans along its heading', () => {
    const v = new Vehicle({ type: 'oht', label: 'T', gx: 5, gy: 5, len: 20, wid: 10 });
    // horizontal body (2 cells long, 1 wide) → 3 cells across one row
    expect(v.footprintAt(5, 5, g, 0)).toEqual([{ gx: 4, gy: 5 }, { gx: 5, gy: 5 }, { gx: 6, gy: 5 }]);
    // rotated 90° → 1 wide, 3 tall
    expect(v.footprintAt(5, 5, g, Math.PI / 2)).toEqual([{ gx: 5, gy: 4 }, { gx: 5, gy: 5 }, { gx: 5, gy: 6 }]);
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

describe('Autopilot — shovel loading reach', () => {
  it('loads from a road on the same or an adjacent block, not two blocks away', () => {
    const g = grid();
    const roads = new Roads(g);
    roads.setNetwork([
      { gx: 20, gy: 20 },   // same block (10,10)
      { gx: 22, gy: 22 },   // diagonally adjacent block (11,11)
      { gx: 26, gy: 20 },   // two blocks east (13,10)
    ]);
    const ap = new Autopilot(g, roads, {});
    const goals = ap._shovelGoals({ bx: 10, by: 10 });
    expect(goals.has('20,20')).toBe(true);
    expect(goals.has('22,22')).toBe(true);
    expect(goals.has('26,20')).toBe(false);
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

describe('Autopilot — overtaking on a parallel lane', () => {
  // A two-lane one-way carriageway (rows 10 & 11, both flowing east).
  function carriageway() {
    const g = grid();
    const roads = new Roads(g);
    const cells = [];
    for (let x = 10; x <= 20; x++) { cells.push({ gx: x, gy: 10, dir: { dx: 1, dy: 0 } }); cells.push({ gx: x, gy: 11, dir: { dx: 1, dy: 0 } }); }
    roads.setNetwork(cells);
    const ap = new Autopilot(g, roads, {});
    return { ap, goals: new Set(['20,10', '20,11']) };
  }

  it('changes lane immediately when the lane ahead is blocked', () => {
    const { ap, goals } = carriageway();
    const t = fakeTruck(15, 10);
    registerTruck(ap, t);
    ap.isFree = (gx, gy) => !(gx === 16 && gy === 10); // a truck blocks the cell ahead
    const a = ap._advance(t, goals, 'g', null);
    expect(a.dir).toEqual([0, 1]);            // pull onto the parallel lane at once
    expect(ap.state.get(t).stuck).toBe(0);    // no waiting — overtake is immediate
  });

  it('stays in lane and drives straight when nothing blocks it', () => {
    const { ap, goals } = carriageway();
    const t = fakeTruck(15, 10);
    registerTruck(ap, t);
    ap.isFree = () => true;
    expect(ap._advance(t, goals, 'g', null).dir).toEqual([1, 0]); // no needless weaving
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
    expect(state.roads.length).toBeGreaterThan(0); // a demo circuit is pre-drawn
  });

  it('starts every truck nose-up on a distinct parking slot', () => {
    const ohts = w.vehicles.filter((v) => v.type === 'oht');
    const slots = new Set(ohts.map((t) => `${t.gx},${t.gy}`));
    expect(slots.size).toBe(ohts.length);                       // no two share a slot
    for (const t of ohts) expect(t.heading).toBeCloseTo(-Math.PI / 2);
  });

  it('pre-draws a demo loop with a crusher reachable from the parking', () => {
    const ap = w.autopilot;
    ap.isFree = () => true;
    const p = w.roads.parkings[0];
    const bays = ap._crusherGoals();
    expect(bays.size).toBeGreaterThan(0);
    expect(ap._reachStatic({ gx: p.x, gy: p.y }, bays, 'C')).toBe(true);
  });

  it('seeds unrevealed ore in blocks adjacent to the demo road', () => {
    let adjacent = 0;
    for (const c of w.roads.serialize()) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const b = w.mine.blocks[Math.floor((c.gy + dy) / 2)]?.[Math.floor((c.gx + dx) / 2)];
        if (b && b.ore && !b.explored) adjacent++;
      }
    }
    expect(adjacent).toBeGreaterThan(0);
  });

  it('omits unexplored blocks and never leaks hidden composition', () => {
    const state = w.fullState();
    expect(Array.isArray(state.blocks)).toBe(true);
    expect(state.blocks.length).toBeLessThan(state.cols * state.rows);   // unexplored omitted
    for (const b of state.blocks) {
      expect(b.explored === true || b.prep === true).toBe(true);          // only significant blocks
      if (!b.explored) expect(b.ore).toBeUndefined();                     // veins never reveal ore
    }
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

  it('buys a PR776 track dozer (off-road, ~R9400 proportions)', () => {
    w.credit = 1000000;
    const r = w.buyAsset('PR776');
    expect(r.ok).toBe(true);
    expect(w.credit).toBe(500000);
    const dz = w.byLabel.get(r.label);
    expect(dz.type).toBe('dozer');
    expect(dz.label).toMatch(/^DZ\d\d$/);
    expect(dz.model).toBe('Liebherr PR776');
    expect(dz.roadOnly).toBe(false);
    expect(dz.len / dz.wid).toBeCloseTo(1.1 / 0.87, 2);   // same proportion as R9400
  });

  it('never spawns a new shovel within 2 blocks of another', () => {
    w.credit = 1e9;
    for (let i = 0; i < 8; i++) expect(w.buyAsset('R9400').ok).toBe(true);
    const shovels = w.vehicles.filter((v) => v.type === 'excavator');
    const blockDist = (a, b) => Math.max(
      Math.abs(Math.floor(a.gx / 2) - Math.floor(b.gx / 2)),
      Math.abs(Math.floor(a.gy / 2) - Math.floor(b.gy / 2)),
    );
    for (let i = 0; i < shovels.length; i++)
      for (let j = i + 1; j < shovels.length; j++)
        expect(blockDist(shovels[i], shovels[j])).toBeGreaterThanOrEqual(3);
  });

  it('rejects a purchase it cannot afford', () => {
    w.credit = 10;
    expect(w.buyAsset('T264').error).toBe('credit');
  });

  it('buys and places an extra crusher for $1,000,000', () => {
    w.credit = 3000000;
    const before = w.crushers.length;
    const r = w.buyCrusher(100, 90);
    expect(r.ok).toBe(true);
    expect(r.credit).toBe(2000000);
    expect(r.extraCrushers).toBe(1);
    expect(w.crushers.length).toBe(before + 1);
    expect(w.crushers.at(-1)).toEqual({ x: 100, y: 90, w: 2, h: 2 });
    expect(w.fullState().crushers.some((c) => c.x === 100 && c.y === 90)).toBe(true);
  });

  it('caps extra crushers at 5 and rejects when broke or overlapping', () => {
    w.credit = 1e9;
    for (let i = 0; i < 5; i++) expect(w.buyCrusher(20 + i * 4, 90).ok).toBe(true);
    expect(w.buyCrusher(60, 90).error).toBe('max');           // 6th rejected
    const w2 = new World();
    w2.credit = 10;
    expect(w2.buyCrusher(100, 90).error).toBe('credit');
    w2.credit = 1e9;
    expect(w2.buyCrusher(100, 90).ok).toBe(true);
    expect(w2.buyCrusher(101, 91).error).toBe('blocked');     // overlaps the previous one
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

  it('reserves a truck centre + rear cell so followers keep a body-length gap', () => {
    const t = w.byLabel.get('OHT01');
    t.heading = 0;                                       // face +x for a deterministic check
    const full = t.footprintAt(t.gx, t.gy, w.grid);     // the sprite body spans several cells
    const collide = t.occupiedCells(w.grid);            // what collision actually reserves
    expect(full.length).toBeGreaterThan(1);
    expect(collide.length).toBeLessThan(full.length);   // tighter than the full body
    const has = (gx, gy) => collide.some((c) => c.gx === gx && c.gy === gy);
    expect(has(t.gx, t.gy)).toBe(true);                 // centre held
    expect(has(t.gx - 1, t.gy)).toBe(true);             // rear cell held → follower gap
    expect(has(t.gx + 1, t.gy)).toBe(false);            // cell AHEAD free → can nuzzle a shovel
  });

  it('shovels still reserve their full multi-cell body', () => {
    const hex = w.byLabel.get('HEX01');
    expect(hex.occupiedCells(w.grid).length).toBeGreaterThan(1);
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

  it('drives a vehicle to a target point via move-to (on/off road)', () => {
    const w = new World();
    const lv = w.byLabel.get('LV01');           // scout (free off-road)
    w.moveTo('LV01', 90, 70);
    expect(w._moveTo.has(lv)).toBe(true);
    let done = false;
    for (let i = 0; i < 8000 && !done; i++) { w.tick(1 / 30); done = !w._moveTo.has(lv); }
    expect(done).toBe(true);                      // order cleared = arrived
    expect([lv.gx, lv.gy]).toEqual([90, 70]);
  });

  it('also routes a road-only haul truck (off-road where needed)', () => {
    const w = new World();
    const oht = w.byLabel.get('OHT01');
    w.moveTo('OHT01', 55, 64);
    let done = false;
    for (let i = 0; i < 9000 && !done; i++) { w.tick(1 / 30); done = !w._moveTo.has(oht); }
    expect(done).toBe(true);
    expect([oht.gx, oht.gy]).toEqual([55, 64]);
  });

  it('manual driving cancels an active move order', () => {
    const w = new World();
    const lv = w.byLabel.get('LV01');
    w.moveTo('LV01', 90, 70);
    expect(w._moveTo.has(lv)).toBe(true);
    w.control('LV01', { dir: [1, 0] });
    expect(w._moveTo.has(lv)).toBe(false);
  });

  it('round-trips the full world through toSnapshot / fromSnapshot', () => {
    const w = new World();
    w.drill(42, 20);                          // keep-out → never a prep vein
    w.credit = 333000;
    w.assign('OHT03', 'HEX01');               // change an autopilot link
    const snap = JSON.parse(JSON.stringify(w.toSnapshot()));   // survives JSON
    const w2 = World.fromSnapshot(snap);
    expect(w2.credit).toBe(333000);
    expect(w2.vehicles.length).toBe(w.vehicles.length);
    expect(w2.mine.blocks[20][42].explored).toBe(true);
    expect(w2.roads.serialize().length).toBe(w.roads.serialize().length);
    expect(w2.autopilot.assignedShovel(w2.byLabel.get('OHT03'))?.label).toBe('HEX01');
    expect(() => { for (let i = 0; i < 60; i++) w2.tick(1 / 30); }).not.toThrow();
  });

  it('snapshotJson is a valid snapshot equal to toSnapshot (grid JSON cached)', () => {
    const w = new World();
    w.drill(40, 20);                               // keep-out → always drillable (never a prep vein)
    const fromJson = JSON.parse(w.snapshotJson());
    expect(fromJson.blocks.length).toBe(w.mine.blocks.length);
    expect(fromJson.credit).toBe(w.toSnapshot().credit);
    const w2 = World.fromSnapshot(fromJson);
    expect(w2.mine.blocks[20][40].explored).toBe(true);
    const cached = w._gridJson;
    w.snapshotJson();
    expect(w._gridJson).toBe(cached);              // reused (grid unchanged)
    w.drill(41, 20);
    w.snapshotJson();
    expect(w._gridJson).not.toBe(cached);          // regenerated after a drill
  });

  it('anyMoving reflects whether the room is idle (for adaptive ticking)', () => {
    const w = new World();
    expect(w.anyMoving()).toBe(false);             // fresh world: parked, nothing moving
    w.moveTo('LV01', 80, 60);
    expect(w.anyMoving()).toBe(true);              // a move order makes it active
  });

  it('addCredit grants money and never goes below zero', () => {
    w.credit = 100000;
    expect(w.addCredit(100000)).toBe(200000);
    expect(w.credit).toBe(200000);
    expect(w.addCredit(-1e9)).toBe(0);     // clamped at 0
    expect(w.addCredit('nope')).toBe(0);   // bad input is a no-op
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

  it('prefers loading from an adjacent road cell, staying on the network', () => {
    // setupHaul runs the road directly above the shovel, so a road cell touches
    // the shovel body — the truck must load there rather than going off-road.
    const { w, oht } = setupHaul();
    const hex = w.byLabel.get('HEX01');
    const phases = new Set();
    let loadedOnRoadAdjacent = false;
    let everLeftRoad = false;
    for (let i = 0; i < 2000; i++) {
      w.tick(1 / 30);
      const st = w.autopilot.state.get(oht);
      if (st) phases.add(st.phase);
      if (oht.offroad) everLeftRoad = true;
      if (st && st.phase === 'loading') {
        const occ = new Set(hex.footprintAt(hex.gx, hex.gy, w.grid).map((c) => `${c.gx},${c.gy}`));
        const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => occ.has(`${oht.gx + dx},${oht.gy + dy}`));
        if (adj && w.roads.isRoad(oht.gx, oht.gy)) loadedOnRoadAdjacent = true;
      }
    }
    expect(loadedOnRoadAdjacent).toBe(true);
    expect(phases.has('docking')).toBe(false);   // never needed to leave the road
    expect(everLeftRoad).toBe(false);
    expect(phases.has('dumping')).toBe(true);
  });

  it('docks off-road into the cell touching the shovel when no road cell does', () => {
    const w = new World();
    const { autopilot: ap, roads, grid: g } = w;
    const hex = w.byLabel.get('HEX01');
    const sbx = Math.floor(hex.gx / 2), sby = Math.floor(hex.gy / 2);
    const b = w.mine.blocks[sby][sbx];
    b.explored = true; b.ore = 'gold'; b.orePct = 15; b.oreRemaining = 1e12; b.dirtRemaining = 0;

    const cbx = sbx + 8;
    w.crushers = [{ x: cbx * 2, y: sby * 2, w: 2, h: 2 }];
    roads.setCrushers(w.crushers); ap._bayCache = null; ap._distCache.clear();

    // Road runs TWO rows above the shovel body, so no road cell touches it
    // (forcing an off-road dock), with a short spur down to the crusher bay.
    const gy = sby * 2 - 2;
    const cells = [];
    for (let gx = 6; gx <= cbx * 2 + 1; gx++) cells.push({ gx, gy, dir: null });
    for (let yy = 5; yy < gy; yy++) cells.push({ gx: 6, gy: yy, dir: null });
    cells.push({ gx: cbx * 2, gy: gy + 1, dir: null });   // bay cell adjacent to the crusher
    w.setRoads(cells);

    const oht = w.byLabel.get('OHT01');
    oht.gx = 6; oht.gy = gy; oht.tgx = 6; oht.tgy = gy; oht.fromGx = 6; oht.fromGy = gy; oht.moving = false;
    oht.x = (6 + 0.5) * g.zoneW; oht.y = (gy + 0.5) * g.zoneH;
    w.assign('OHT01', 'HEX01');

    const phases = new Set();
    let offRoadAdjacent = false;
    for (let i = 0; i < 2000; i++) {
      w.tick(1 / 30);
      const st = ap.state.get(oht);
      if (st) phases.add(st.phase);
      if (st && st.phase === 'loading') {
        const occ = new Set(hex.footprintAt(hex.gx, hex.gy, w.grid).map((c) => `${c.gx},${c.gy}`));
        const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => occ.has(`${oht.gx + dx},${oht.gy + dy}`));
        if (adj && !w.roads.isRoad(oht.gx, oht.gy)) offRoadAdjacent = true;
      }
    }
    expect(phases.has('docking')).toBe(true);
    expect(phases.has('undocking')).toBe(true);
    expect(offRoadAdjacent).toBe(true);
    expect(phases.has('dumping')).toBe(true);
  });

  it('exposes a debug plan for a vehicle when enabled', () => {
    const { w } = setupHaul();
    w.setDebug('OHT01', true);
    w.tick(1 / 30);
    const plan = w.debugPaths().OHT01;
    expect(plan).toBeTruthy();
    expect(Array.isArray(plan.path)).toBe(true);
  });

  it('dodges a shovel parked across its only road and still reaches the crusher', () => {
    const w = new World();
    const { autopilot: ap, grid: g } = w;
    const row = 40;
    const cells = [];
    for (let gx = 6; gx <= 41; gx++) cells.push({ gx, gy: row, dir: null });
    w.crushers = [{ x: 40, y: row + 1, w: 2, h: 2 }];     // bay = corridor cell (40,row)
    w.roads.setCrushers(w.crushers); ap._bayCache = null; ap._distCache.clear();
    w.setRoads(cells);

    const oht = w.byLabel.get('OHT01');
    oht.gx = 6; oht.gy = row; oht.tgx = 6; oht.tgy = row; oht.fromGx = 6; oht.fromGy = row;
    oht.moving = false; oht.heading = 0; oht.load = 240; oht.loadOre = 'iron';
    oht.x = 6.5 * g.zoneW; oht.y = (row + 0.5) * g.zoneH;
    w.assign('OHT01', null);
    ap.links.set(oht, w.byLabel.get('HEX01'));
    ap.state.set(oht, { phase: 'to_crusher', dir: null, timer: 0, bucket: 0, stuck: 0, want: null, yield: null });

    // A shovel settled right on the corridor, blocking the lane (manual = never relocates).
    const hex = w.byLabel.get('HEX02');
    hex.gx = 22; hex.gy = row; hex.tgx = 22; hex.tgy = row; hex.moving = false; hex.heading = 0; hex.place(g);
    ap.setManual(hex);

    let dodged = false, dumped = false, maxX = oht.gx;
    for (let i = 0; i < 3000; i++) {
      w.tick(1 / 30);
      const st = ap.state.get(oht);
      if (st && st.dodge) dodged = true;
      if (st && st.phase === 'dumping') dumped = true;
      maxX = Math.max(maxX, oht.gx);
    }
    expect(dodged).toBe(true);          // it had to skirt the shovel
    expect(maxX).toBeGreaterThan(22);   // and got past it
    expect(dumped).toBe(true);          // reaching the crusher
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

  it('relocates onto a sub-zone where its body clears nearby roads', () => {
    const { w, hex, bx, by } = setupShovel();        // ore at (bx+1, by)
    // a road just left of the target block, within the shovel body's reach
    w.setRoads([{ gx: bx * 2 + 1, gy: by * 2 }]);
    w.autopilot._updateShovels();
    const mv = w.autopilot._shovelMove.get(hex);
    expect(mv).toBeTruthy();
    for (const c of hex.footprintAt(mv.gx, mv.gy, w.grid))
      expect(w.roads.isRoad(c.gx, c.gy)).toBe(false); // body never straddles the road
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

// ── Parking: alignment & resize ───────────────────────────────────────────────

describe('World — parking alignment & resize', () => {
  it('starts haul trucks aligned nose-up in the pad', () => {
    const w = new World();
    expect(w.byLabel.get('OHT01').heading).toBeCloseTo(-Math.PI / 2);
  });

  it('parks a truck nose-up on arrival', () => {
    const w = new World();
    const oht = w.byLabel.get('OHT01');
    const st = { phase: 'to_parking', dir: null, timer: 0, stuck: 0, want: null, yield: null };
    w.autopilot.state.set(oht, st);
    w.autopilot.links.set(oht, w.byLabel.get('HEX01'));
    // place it right on its slot so _advance reports arrival immediately
    const slot = w.autopilot._parkSlot(oht);
    oht.gx = slot.gx; oht.gy = slot.gy; oht.tgx = slot.gx; oht.tgy = slot.gy; oht.moving = false;
    oht.heading = 0;
    w.autopilot._tickToParking(oht, st);
    expect(st.phase).toBe('parked');
    expect(oht.heading).toBeCloseTo(-Math.PI / 2);
  });

  it('sizes the pad for the fleet with ≥50% spare, growing when needed', () => {
    const w = new World();
    const small = w._sizedParkingRect(4);           // default fleet fits the base pad
    expect(small.w * Math.ceil(small.h / 2)).toBeGreaterThanOrEqual(6);
    const big = w._sizedParkingRect(40);            // needs 60 slots → must grow
    expect(big.w * Math.ceil(big.h / 2)).toBeGreaterThanOrEqual(60);
  });

  it('lays nose-up slots one column apart and two rows apart', () => {
    const w = new World();
    w.resizeParking({ x: 4, y: 4, w: 4, h: 4 });
    w.autopilot._buildSlots();
    const slots = w.autopilot._slots.map((s) => `${s.gx},${s.gy}`);
    expect(w.autopilot._slots.length).toBe(8);     // 4 cols × 2 rows
    expect(slots).toContain('4,4');
    expect(slots).toContain('7,4');
    expect(slots).toContain('4,6');
    expect(slots).not.toContain('4,5');            // rows are two apart
  });

  it('resizes the pad, drops road inside it, keeps road outside', () => {
    const w = new World();
    w.setRoads([{ gx: 20, gy: 20, dir: null }, { gx: 2, gy: 2, dir: null }]);
    const r = w.resizeParking({ x: 18, y: 18, w: 6, h: 4 });
    expect(r).toEqual({ x: 18, y: 18, w: 6, h: 4 });
    expect(w.roads.cells.get('20,20').parking).toBe(true);                 // now a pad cell
    expect(w.roads.serialize().some((c) => c.gx === 20 && c.gy === 20)).toBe(false); // not drawn road
    expect(w.roads.isRoad(2, 2)).toBe(true);                              // outside road stays
    expect(w.fullState().parking).toEqual({ x: 18, y: 18, w: 6, h: 4 });
  });

  it('clamps the resize to a minimum 2×2 within bounds', () => {
    const w = new World();
    const r = w.resizeParking({ x: -5, y: -5, w: 1, h: 1 });
    expect(r.x).toBe(0); expect(r.y).toBe(0);
    expect(r.w).toBeGreaterThanOrEqual(2);
    expect(r.h).toBeGreaterThanOrEqual(2);
  });
});

describe('rich prep veins (World)', () => {
  // A dozer placed one block above zone 0, registered with the world.
  function withDozer() {
    const w = new World();
    const z = w.mine.veins[0];
    const g = w.grid;
    let pb = null;                              // a real zone-0 block (bbox corner may be empty)
    for (let y = z.y0; y <= z.y1 && !pb; y++)
      for (let x = z.x0; x <= z.x1; x++) { const b = w.mine.blocks[y][x]; if (b.prep && b.veinId === 0) { pb = b; break; } }
    const dz = new Vehicle({ type: 'dozer', label: 'DZ01', gx: pb.x * 2, gy: pb.y * 2, len: g.zoneW * 0.9, wid: g.zoneH * 0.6 });
    dz.place(g);
    w.vehicles.push(dz); w.byLabel.set('DZ01', dz);
    return { w, z, dz };
  }

  it('refuses to drill an un-prepared prep block', () => {
    const w = new World();
    const z = w.mine.veins[0];
    let pb = null;                              // a real vein block (bbox corner may be empty)
    for (let y = z.y0; y <= z.y1 && !pb; y++)
      for (let x = z.x0; x <= z.x1; x++) { const b = w.mine.blocks[y][x]; if (b.prep) { pb = b; break; } }
    const r = w.drill(pb.x, pb.y);
    expect(r.error).toBe('requires dozer preparation');
    expect(pb.explored).toBe(false);
  });

  it('still drills a normal (non-prep) block', () => {
    const w = new World();
    const r = w.drill(10, 10);                 // spawn keep-out → never a prep vein
    expect(r.block.explored).toBe(true);
  });

  it('drops road cells laid on an un-prepared vein, allows them once revealed', () => {
    const w = new World();
    const z = w.mine.veins[0];
    let pb = null;
    for (let y = z.y0; y <= z.y1 && !pb; y++)
      for (let x = z.x0; x <= z.x1; x++) { const b = w.mine.blocks[y][x]; if (b.prep) { pb = b; break; } }
    const vx = pb.x * 2, vy = pb.y * 2;        // a sub-zone cell on the vein block
    w.setRoads([{ gx: vx, gy: vy, dir: null }, { gx: 12, gy: 12, dir: null }]);
    expect(w.roads.isRoad(vx, vy)).toBe(false);  // vein cell rejected
    expect(w.roads.isRoad(12, 12)).toBe(true);   // normal cell kept

    pb.explored = true;                          // dozer revealed it
    w.setRoads([{ gx: vx, gy: vy, dir: null }, { gx: 12, gy: 12, dir: null }]);
    expect(w.roads.isRoad(vx, vy)).toBe(true);   // now allowed
  });

  it('a nearby dozer auto-starts and reveals vein blocks by passing over them', () => {
    const { w, z, dz } = withDozer();
    const start = z.remaining;
    let started = false, revealed = 0;
    for (let t = 0; t < 20000 && z.remaining === start; t++) {
      w.tick(1 / 30);
      if (w._dozerPrep.has(dz)) started = true;
    }
    expect(started).toBe(true);                // auto-started within range
    expect(z.remaining).toBeLessThan(start);   // at least one block prepared & revealed
    for (let y = z.y0; y <= z.y1; y++)
      for (let x = z.x0; x <= z.x1; x++) if (w.mine.blocks[y][x].explored) revealed++;
    expect(revealed).toBeGreaterThan(0);
  });

  it('does not auto-start a dozer that is too far from any vein', () => {
    const w = new World();
    const g = w.grid;
    // far corner, guaranteed >5 blocks from any 10×15 zone in the keep-out-free area
    const dz = new Vehicle({ type: 'dozer', label: 'DZF', gx: 10, gy: 10, len: g.zoneW * 0.9, wid: g.zoneH * 0.6 });
    dz.place(g);
    w.vehicles.push(dz); w.byLabel.set('DZF', dz);
    w.tick(1 / 30);
    // (10,10) is in the spawn keep-out; the nearest vein is well beyond 5 blocks
    expect(w._dozerPrep.has(dz)).toBe(false);
  });
});
