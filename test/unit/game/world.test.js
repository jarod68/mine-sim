import { describe, it, expect, beforeEach } from 'vitest';
import {
  World, Vehicle, Roads, Autopilot,
  VIEW_W, VIEW_H, COLS, ROWS, DRILL_COST, ROAD_COST, ROAD_WEAR_LIMIT, WORN_SPEED_MULT, REPAIR_TIME,
} from '../../../game/world.js';
import { sizedParkingRect } from '../../../game/world-setup.js';
import { padSlots } from '../../../game/constants.js';

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

  it('keeps a steady heading while blocked (no frantic sprite jitter)', () => {
    const v = new Vehicle({ type: 'pickup', label: 'L', gx: 5, gy: 5, len: 9, wid: 5 });
    v.place(g);
    v.heading = 0;                                     // facing east
    const blocked = () => false;                       // every target cell is occupied
    // feed it alternating desired directions while it can't move
    v.update(0.01, [0, 1], g, () => true, blocked);    // wants to turn south…
    v.update(0.01, [0, -1], g, () => true, blocked);   // …then north
    expect(v.moving).toBe(false);
    expect(v.heading).toBe(0);                         // heading unchanged — it didn't spin in place
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

  it('degrades a cell after the wear limit, then a grader pass repairs it', () => {
    const roads = new Roads(grid());
    roads.setNetwork([{ gx: 5, gy: 5 }]);
    for (let i = 0; i < ROAD_WEAR_LIMIT - 1; i++) expect(roads.wearPass(5, 5)).toBe(false);
    expect(roads.isWorn(5, 5)).toBe(false);
    expect(roads.wearPass(5, 5)).toBe(true);    // the pass that tips it over
    expect(roads.isWorn(5, 5)).toBe(true);
    expect(roads.wornKeys().has('5,5')).toBe(true);
    expect(roads.repairCell(5, 5)).toBe(true);  // grader smooths it back out
    expect(roads.isWorn(5, 5)).toBe(false);
    expect(roads.wornKeys().size).toBe(0);
  });

  it('never wears a parking pad cell', () => {
    const roads = new Roads(grid());
    roads.addParking(0, 0, 2, 2);
    for (let i = 0; i < ROAD_WEAR_LIMIT + 5; i++) roads.wearPass(0, 0);
    expect(roads.isWorn(0, 0)).toBe(false);
  });

  it('preserves cell wear across a re-draw (client edit) and serializes it', () => {
    const roads = new Roads(grid());
    roads.setNetwork([{ gx: 5, gy: 5, dir: { dx: 1, dy: 0 } }]);
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(5, 5);
    // a client edit re-sends the cell WITHOUT a wear field — wear must survive
    roads.setNetwork([{ gx: 5, gy: 5, dir: { dx: 1, dy: 0 } }]);
    expect(roads.isWorn(5, 5)).toBe(true);
    expect(roads.serialize()[0].wear).toBe(ROAD_WEAR_LIMIT);
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

describe('Autopilot — grader auto-repair', () => {
  const g = grid();
  const longRoad = () => {
    const roads = new Roads(g);
    const cells = [];
    for (let x = 4; x <= 36; x++) cells.push({ gx: x, gy: 20 });
    roads.setNetwork(cells);
    const ap = new Autopilot(g, roads, {});
    ap.setEnabled(true);
    ap.isFree = () => true;
    return { roads, ap };
  };
  const grader = (gx, gy) => {
    const v = new Vehicle({ type: 'grader', label: `GR${gx}`, gx, gy, len: 14, wid: 5 });
    v.place(g);
    return v;
  };

  it('sends a lone grader to the nearest worn cell and drives toward it', () => {
    const { roads, ap } = longRoad();
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(30, 20);
    const gr = grader(10, 20);
    ap.addGrader(gr);
    ap._updateGraders();
    expect(ap._graderState.get(gr).target).toBe('30,20');
    expect(ap.controls(gr)).toBe(true);
    expect(ap.dirFor(gr)).toEqual([1, 0]);          // heads east toward the damage
  });

  it('fans multiple graders out to different worn areas', () => {
    const { roads, ap } = longRoad();
    for (const x of [6, 7, 33, 34]) for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(x, 20);
    const g1 = grader(4, 20);
    const g2 = grader(36, 20);
    ap.addGrader(g1); ap.addGrader(g2);
    ap._updateGraders();
    const t1 = ap._graderState.get(g1).target;
    const t2 = ap._graderState.get(g2).target;
    expect(t1).not.toBe(t2);                          // spread, not stacked on one cell
  });

  it('sends a spare grader to rest instead of stacking on a claimed cell', () => {
    const { roads, ap } = longRoad();
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(30, 20);   // a single worn cell
    const g1 = grader(10, 20);
    const g2 = grader(12, 20);
    ap.addGrader(g1); ap.addGrader(g2);
    ap._updateGraders();
    const targets = [g1, g2].map((v) => ap._graderState.get(v).target);
    expect(targets.filter((t) => t === '30,20').length).toBe(1);  // exactly one grader takes the job
    expect(targets.filter((t) => t === null).length).toBe(1);     // the other goes and rests
  });

  it('lets several graders share one big worn cluster on distinct cells', () => {
    const { roads, ap } = longRoad();
    for (const x of [28, 29, 30]) for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(x, 20);
    const g1 = grader(10, 20);
    const g2 = grader(12, 20);
    ap.addGrader(g1); ap.addGrader(g2);
    ap._updateGraders();
    const t1 = ap._graderState.get(g1).target;
    const t2 = ap._graderState.get(g2).target;
    expect(t1).toBeTruthy();
    expect(t2).toBeTruthy();
    expect(t1).not.toBe(t2);                          // same area is fine, same cell is not
  });

  it('parks a grader (null target) when no road is degraded', () => {
    const { roads, ap } = longRoad();
    roads.addParking(0, 0, 6, 3);
    const gr = grader(20, 20);
    ap.addGrader(gr);
    ap._updateGraders();
    expect(ap._graderState.get(gr).target).toBeNull();
    expect(ap.dirFor(gr)).not.toBeNull();             // still moving — toward the parking pad
  });

  const oneWayRoad = (dir) => {
    const roads = new Roads(g);
    const cells = [];
    for (let x = 4; x <= 36; x++) cells.push({ gx: x, gy: 20, dir });
    roads.setNetwork(cells);
    const ap = new Autopilot(g, roads, {});
    ap.setEnabled(true);
    ap.isFree = () => true;
    return { roads, ap };
  };

  it('drives a grader along the road WITH the one-way flow, staying on the network', () => {
    const { roads, ap } = oneWayRoad({ dx: 1, dy: 0 });   // eastbound only
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(28, 20);
    const gr = grader(8, 20);
    ap.addGrader(gr);
    let reached = false;
    for (let t = 0; t < 200; t++) {
      ap._updateGraders();
      const d = ap.dirFor(gr);
      if (d === null) { reached = gr.gx === 28 && gr.gy === 20; break; }
      expect(d[0]).not.toBe(-1);                        // never against the flow
      gr.gx += d[0]; gr.gy += d[1];
      expect(roads.isRoad(gr.gx, gr.gy)).toBe(true);    // stays on the tarmac
      if (gr.gx === 28 && gr.gy === 20) { reached = true; break; }
    }
    expect(reached).toBe(true);
  });

  it('asks a stationary truck blocking its lane to give way (grader has priority)', () => {
    const { roads, ap } = oneWayRoad({ dx: 1, dy: 0 });
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(28, 20);
    const gr = grader(8, 20);
    ap.addGrader(gr);
    const truck = new Vehicle({ type: 'oht', label: 'OHT01', gx: 9, gy: 20, len: 14, wid: 7 });
    truck.place(g);
    ap.state.set(truck, { phase: 'to_parking', dir: null, timer: 0, stuck: 0, want: null });
    ap.isFree = (gx, gy, self) => !(self !== truck && gx === truck.gx && gy === truck.gy);
    ap._updateGraders();
    ap.dirFor(gr);                                      // grader blocked by the truck ahead
    const st = ap.state.get(truck);
    expect(st.giveWay).toBeTruthy();                   // truck told to pull aside
    ap._tickGiveWay(truck, st);
    expect(st.dir).not.toBeNull();                     // and it steps off the lane
    expect(truck.offroad).toBe(true);
  });

  it('routes a grader AROUND a shovel blocking its one-way lane, never against the flow', () => {
    const { roads, ap } = oneWayRoad({ dx: 1, dy: 0 });    // one-way east, x=4..36 on row 20
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) roads.wearPass(30, 20);
    const hex = new Vehicle({ type: 'excavator', label: 'HEX', gx: 18, gy: 20, len: 12, wid: 9 });
    hex.place(g); ap.addShovel(hex);                       // parked across the lane
    const occ = new Set(hex.occupiedCells(g).map((c) => `${c.gx},${c.gy}`));
    ap.isFree = (gx, gy, self) => self === hex || !occ.has(`${gx},${gy}`);
    const gr = grader(8, 20);
    ap.addGrader(gr);
    let reached = false, against = false;
    for (let t = 0; t < 400; t++) {
      ap._updateGraders();
      const d = ap.dirFor(gr);
      if (d) {
        const c = roads.cells.get(`${gr.gx},${gr.gy}`);
        if (c && c.dir && d[0] === -c.dir.dx && d[1] === -c.dir.dy) against = true;
        if (ap._canOccupy(gr, gr.gx + d[0], gr.gy + d[1], d[0], d[1])) { gr.fromGx = gr.gx; gr.fromGy = gr.gy; gr.gx += d[0]; gr.gy += d[1]; }
      }
      if (gr.gx === 30 && gr.gy === 20) { reached = true; break; }
    }
    expect(against).toBe(false);                          // never drove the wrong way
    expect(reached).toBe(true);                           // got past the shovel to the worn cell
  });
});

describe('Autopilot — dozers as priority obstacles', () => {
  it('counts dozer and grader bodies among the cells haul trucks skirt', () => {
    const g = grid();
    const ap = new Autopilot(g, new Roads(g), {});
    const dz = new Vehicle({ type: 'dozer', label: 'DZ01', gx: 10, gy: 10, len: 12, wid: 10 });
    const gr = new Vehicle({ type: 'grader', label: 'GR01', gx: 20, gy: 20, len: 14, wid: 5 });
    dz.place(g); gr.place(g);
    ap.addDozer(dz); ap.addGrader(gr);
    const cells = ap._shovelCells();
    expect(cells.has('10,10')).toBe(true);   // dozer body → trucks skirt it
    expect(cells.has('20,20')).toBe(true);   // grader body too
  });
});

describe('World — dozer follows road flow', () => {
  it('picks the progress direction matching the one-way flow it sits on', () => {
    const w = new World();
    const dz = new Vehicle({ type: 'dozer', label: 'DZ09', gx: 30, gy: 30, len: 12, wid: 10 });
    dz.place(w.grid);
    // a single east-flowing road cell under the dozer
    w.roads.cells.set('30,30', { gx: 30, gy: 30, dir: { dx: 1, dy: 0 } });
    // both progressing east (with the flow) and south are options → flow wins
    expect(w._dozerFlowPick(dz, [[0, 1], [1, 0]])).toEqual([1, 0]);
    // no option aligns with the flow → null (caller keeps its default order)
    expect(w._dozerFlowPick(dz, [[0, 1], [0, -1]])).toBeNull();
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

  it('never side-steps onto another road (no runaway march down a crossing lane)', () => {
    const g = grid();
    const roads = new Roads(g);
    const cells = [{ gx: 10, gy: 10 }, { gx: 11, gy: 10 }];        // the jammed lane (E-W)
    for (let gy = 5; gy <= 15; gy++) cells.push({ gx: 10, gy });   // a crossing N-S lane
    roads.setNetwork(cells);
    const ap = new Autopilot(g, roads, {});
    ap.isFree = () => true;
    const t = fakeTruck(10, 10);
    // both perpendicular cells are road → hold rather than wander down the lane
    expect(ap._sideStepOff(t, { gx: 10, gy: 10 }, [1, 0])).toBeNull();
    // on a plain lane, open ground beside it is fine
    expect(ap._sideStepOff(t, { gx: 11, gy: 10 }, [1, 0])).toEqual([0, 1]);
  });

  it('abandons a yield when the opponent leaves the area or never passes', () => {
    const g = grid();
    const roads = new Roads(g);
    const cells = [];
    for (let x = 5; x <= 25; x++) cells.push({ gx: x, gy: 10 });
    roads.setNetwork(cells);
    const ap = new Autopilot(g, roads, {});
    ap.isFree = () => true;
    const A = fakeTruck(10, 10), B = fakeTruck(20, 10);
    registerTruck(ap, A); registerTruck(ap, B);
    const st = ap.state.get(A);
    // opponent still "ahead along the axis" but 10 cells away → gone, resume
    st.yield = { to: B, axis: [1, 0], parked: true };
    expect(ap._yieldStep(A, st)).toBeNull();
    expect(st.yield).toBeNull();
    // opponent close but frozen → the hard timeout releases the yielder
    B.gx = 12; B.tgx = 12;
    st.yield = { to: B, axis: [1, 0], parked: true };
    for (let i = 0; i < 241; i++) ap._yieldStep(A, st);
    expect(st.yield).toBeNull();
  });

  it('a long-gridlocked truck pulls off the road to clear the lane (anti-cascade)', () => {
    const g = grid();
    const roads = new Roads(g);
    roads.setNetwork([{ gx: 10, gy: 10 }, { gx: 11, gy: 10 }]);   // a tiny dead-end road
    const ap = new Autopilot(g, roads, {});
    ap.setEnabled(true);
    const truck = fakeTruck(10, 10), block = fakeTruck(11, 10);
    registerTruck(ap, truck); registerTruck(ap, block);
    ap.state.get(truck).phase = 'to_crusher'; ap.state.get(block).phase = 'to_crusher';  // same queue
    ap.isFree = (gx, gy, self) => self === block || !(gx === 11 && gy === 10);            // blocker cell taken
    const st = ap.state.get(truck);
    st.stuck = 100;                                  // jammed far longer than a normal wait
    st.want = { gx: 11, gy: 10 };
    ap._startDodgeIfStuck(truck, new Set(['11,10']), 'C', st);
    expect(st.clearLane).toBeTruthy();               // it gives up its place in line and pulls aside
    expect(st.clearLane.want).toEqual({ gx: 11, gy: 10 });
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

  it('spawns a bought T264 already parked "en bataille" (nose-up, on a rank slot)', () => {
    const parkHeading = w.vehicles.find((v) => v.type === 'oht').heading;   // default fleet is parked
    const r = w.buyAsset('T264');
    const t = w.byLabel.get(r.label);
    expect(t.type).toBe('oht');
    expect(t.moving).toBe(false);
    expect(t.heading).toBe(parkHeading);                  // nose-up like the rest of the fleet
    const pad = w.roads.parkings[0];
    // Sits on a rank slot (bottom-anchored so body + rear cell stay inside the pad).
    expect(padSlots(pad).some((s) => s.gx === t.gx && s.gy === t.gy)).toBe(true);
    expect(t.gx).toBeGreaterThanOrEqual(pad.x);
    expect(t.gx).toBeLessThan(pad.x + pad.w);
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

  // Cells well clear of the starter circuit (max gx 25 / gy 18) and inside the
  // vein keep-out (blocks ≤46×≤26), so they're deterministically new + buildable.
  const FREE = [{ gx: 30, gy: 40 }, { gx: 31, gy: 40 }, { gx: 32, gy: 40 }, { gx: 33, gy: 40 }];

  it('charges ROAD_COST for each newly built road cell, free for existing ones', () => {
    w.setRoads([]);                              // clear the free starter network
    const before = w.credit;
    const r1 = w.setRoads(FREE.slice(0, 3));
    expect(r1.added).toBe(3);
    expect(r1.cost).toBe(3 * ROAD_COST);
    expect(w.credit).toBe(before - 3 * ROAD_COST);
    // The spend-pop anchor is the centroid of the newly built cells.
    expect(r1.gx).toBe(31);   // (30+31+32)/3
    expect(r1.gy).toBe(40);
    // Re-sending the same network plus one extra only charges the new cell.
    const r2 = w.setRoads(FREE);
    expect(r2.added).toBe(1);
    expect(w.credit).toBe(before - 4 * ROAD_COST);
  });

  it('does not refund erased road cells', () => {
    w.setRoads([]);
    w.setRoads(FREE.slice(0, 2));
    const mid = w.credit;
    const r = w.setRoads(FREE.slice(0, 1));      // erase one
    expect(r.added).toBe(0);
    expect(r.cost).toBe(0);
    expect(w.credit).toBe(mid);                  // no refund
  });

  it('builds only what the budget allows and reports the dropped cells', () => {
    w.setRoads([]);                              // empty baseline
    w.credit = ROAD_COST * 2 + 50;               // affords 2 new cells
    const r = w.setRoads(FREE);
    expect(r.added).toBe(2);
    expect(r.dropped).toBe(2);
    expect(w.credit).toBe(50);
    expect(w.roads.serialize().length).toBe(2);
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

  it('emits a crusher "+$" payout pop on delivery, then clears it', () => {
    w.liveDelta();                       // drain the initial frame
    w._deliver('iron', 240, 0);          // one truckload of iron at crusher 0 = $10,000
    const d = w.liveDelta();
    expect(d.payouts).toHaveLength(1);
    expect(d.payouts[0].amount).toBe(10000);
    const cr = w.crushers[0];
    expect(d.payouts[0].gx).toBeCloseTo(cr.x + cr.w / 2, 5);
    expect(d.payouts[0].gy).toBeCloseTo(cr.y + cr.h / 2, 5);
    expect(w.liveDelta()).toBeNull();    // payout consumed, nothing left to send
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

  it('routes every vehicle AROUND a shovel straddling a road (never through it)', () => {
    for (const tested of ['LV01', 'OHT01']) {     // a narrow scout and a wide haul truck
      const w = new World();
      const gy = 70;
      const cells = [];
      for (let x = 30; x <= 70; x++) cells.push({ gx: x, gy });
      w.setRoads(cells);
      const hex = w.byLabel.get('HEX01');
      hex.gx = 50; hex.gy = gy; hex.place(w.grid);     // shovel parked across the road
      for (const v of w.vehicles) w.autopilot.setManual(v);  // park everyone else
      const v = w.byLabel.get(tested);
      v.gx = 35; v.gy = gy; v.place(w.grid);
      w.moveTo(tested, 68, gy);
      const onShovel = new Set(hex.occupiedCells(w.grid).map((c) => `${c.gx},${c.gy}`));
      let touched = false, done = false;
      for (let i = 0; i < 6000 && !done; i++) {
        w.tick(1 / 30);
        if (onShovel.has(`${v.gx},${v.gy}`)) touched = true;
        done = !w._moveTo.has(v);
      }
      expect(touched).toBe(false);                      // never drove onto the shovel
      expect([v.gx, v.gy]).toEqual([68, gy]);           // and still reached the far side
    }
  });

  it('move-to beelines straight across terrain, never detouring to follow roads', () => {
    const w = new World();
    const lv = w.byLabel.get('LV01');
    lv.gx = lv.tgx = 50; lv.gy = lv.tgy = 50; lv.moving = false; lv.place(w.grid);
    const path = w._planMovePath(lv, 90, 70);
    expect(path).toBeTruthy();
    // A direct route: within a small obstacle-bend tolerance of the Manhattan
    // distance (a road-following route would be far longer).
    expect(path.length - 1).toBeLessThanOrEqual(Math.abs(90 - 50) + Math.abs(70 - 50) + 6);
  });

  it('recovers a truck stranded far off-road back onto the network', () => {
    const w = new World();
    const oht = w.byLabel.get('OHT01');
    // Strand it where no road exists within 9 cells (as an abandoned dodge or
    // clear-lane manoeuvre might) — it must still find its way back, always.
    let far = null;
    for (let gy = 40; gy < w.grid.zoneRows && !far; gy++)
      for (let gx = 40; gx < w.grid.zoneCols && !far; gx++) {
        let clear = true;
        for (let dy = -9; dy <= 9 && clear; dy++)
          for (let dx = -9; dx <= 9 && clear; dx++)
            if (w.roads.isRoad(gx + dx, gy + dy)) clear = false;
        if (clear) far = { gx, gy };
      }
    expect(far).toBeTruthy();
    oht.gx = oht.tgx = far.gx; oht.gy = oht.tgy = far.gy; oht.moving = false; oht.place(w.grid);
    w.autopilot.state.get(oht).phase = 'to_crusher';
    let backOn = false;
    for (let i = 0; i < 3000 && !backOn; i++) { w.tick(1 / 30); backOn = w.roads.isRoad(oht.gx, oht.gy); }
    expect(backOn).toBe(true);
  });

  it('manual steering always frees a boxed-in vehicle (drives through the blockade)', () => {
    const w = new World();
    const oht = w.byLabel.get('OHT01');
    oht.gx = oht.tgx = 30; oht.gy = oht.tgy = 30; oht.moving = false; oht.place(w.grid);
    // Box it in on all four sides with stationary vehicles (noses toward it, so
    // their rear collision cells extend outward — the tightest possible cage).
    const cage = [['OHT02', 31, 30, Math.PI], ['OHT03', 29, 30, 0], ['OHT04', 30, 31, -Math.PI / 2], ['LV01', 30, 29, Math.PI / 2]];
    for (const [label, gx, gy, heading] of cage) {
      const v = w.byLabel.get(label);
      v.gx = v.tgx = gx; v.gy = v.tgy = gy; v.moving = false; v.heading = heading; v.place(w.grid);
      w.autopilot.setManual(v);
    }
    w.control('OHT01', { dir: [1, 0] });
    for (let i = 0; i < 120; i++) w.tick(1 / 30);
    expect(oht.gx).toBeGreaterThan(30);              // escaped east straight through
  });

  it('a move-to order crosses a blockade instead of giving up', () => {
    const w = new World();
    const lv = w.byLabel.get('LV01');
    lv.gx = lv.tgx = 40; lv.gy = lv.tgy = 40; lv.moving = false; lv.place(w.grid);
    // A solid wall of stationary trucks right across the direct route.
    ['OHT01', 'OHT02', 'OHT03', 'OHT04'].forEach((label, i) => {
      const v = w.byLabel.get(label);
      v.gx = v.tgx = 44; v.gy = v.tgy = 38 + i; v.moving = false; v.heading = 0; v.place(w.grid);
      w.autopilot.setManual(v);
    });
    w.moveTo('LV01', 48, 40);
    let done = false;
    for (let i = 0; i < 2000 && !done; i++) { w.tick(1 / 30); done = !w._moveTo.has(lv); }
    expect(done).toBe(true);
    expect([lv.gx, lv.gy]).toEqual([48, 40]);
  });

  it('manual driving cancels an active move order', () => {
    const w = new World();
    const lv = w.byLabel.get('LV01');
    w.moveTo('LV01', 90, 70);
    expect(w._moveTo.has(lv)).toBe(true);
    w.control('LV01', { dir: [1, 0] });
    expect(w._moveTo.has(lv)).toBe(false);
  });

  it('wears a road on vehicle passes and broadcasts the worn flip; trucks then crawl', () => {
    const w = new World();
    w.setRoads([{ gx: 25, gy: 30, dir: { dx: 1, dy: 0 } }]);
    const lv = w.byLabel.get('LV01');
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) { lv.gx = 25; lv.gy = 30; w._roadPass(lv); }
    expect(w.roads.isWorn(25, 30)).toBe(true);
    const d = w.liveDelta();
    expect(d.roads).toEqual([{ gx: 25, gy: 30, worn: true }]);

    // a haul truck sitting on the degraded cell is slowed to the worn factor
    const oht = w.byLabel.get('OHT01');
    oht.gx = 25; oht.gy = 30; oht.place(w.grid);
    w.tick(1 / 30);
    expect(oht.speedMul).toBe(WORN_SPEED_MULT);
  });

  it('a grader pass repairs a degraded cell and broadcasts the fix', () => {
    const w = new World();
    w.credit = 1e7;
    w.setRoads([{ gx: 25, gy: 30 }]);
    const lv = w.byLabel.get('LV01');
    for (let i = 0; i < ROAD_WEAR_LIMIT; i++) { lv.gx = 25; lv.gy = 30; w._roadPass(lv); }
    w.liveDelta();                                   // drain the "worn" frame
    const gr = w.byLabel.get(w.buyAsset('CAT24').label);
    expect(w.autopilot.graders.has(gr)).toBe(true);
    gr.gx = 25; gr.gy = 30; w._roadPass(gr);         // grader drives onto it
    expect(w.roads.isWorn(25, 30)).toBe(false);
    expect(w.liveDelta().roads).toEqual([{ gx: 25, gy: 30, worn: false }]);
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
    // Keep the other shovels productive on their own blocks so none of them
    // relocates to (and claims) the test's ore block — shovels never stack.
    for (const lbl of ['HEX02', 'HEX03', 'HEX04']) {
      const s = w.byLabel.get(lbl);
      const b = w.mine.blocks[Math.floor(s.gy / 2)][Math.floor(s.gx / 2)];
      b.explored = true; b.ore = 'iron'; b.orePct = 50; b.oreRemaining = 5000;
    }
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

  it('never relocates two shovels onto the same ore block', () => {
    const { w, hex } = setupShovel();                  // HEX01 will claim the ore block east of it
    const h2 = w.byLabel.get('HEX02');
    const b2 = w.mine.blocks[Math.floor(h2.gy / 2)][Math.floor(h2.gx / 2)];
    b2.ore = null; b2.oreRemaining = 0;                // HEX02 idle too — hunting for ore
    w.autopilot._updateShovels();
    const m1 = w.autopilot._shovelMove.get(hex);
    expect(m1).toBeTruthy();
    const m2 = w.autopilot._shovelMove.get(h2);
    if (m2) {
      const same = Math.floor(m2.gx / 2) === Math.floor(m1.gx / 2)
                && Math.floor(m2.gy / 2) === Math.floor(m1.gy / 2);
      expect(same).toBe(false);
    }
  });

  it('prefers a truck-accessible ore block over an equally-near inaccessible one', () => {
    const { w, hex, bx, by } = setupShovel();          // ore already at the EAST block (bx+1, by)
    const south = w.mine.blocks[by + 1][bx];           // an equally-near ore block to the south…
    south.explored = true; south.ore = 'iron'; south.oreRemaining = 5000;
    // …but only the EAST block gets a road bay (a truck can load there)
    w.setRoads([{ gx: (bx + 1) * 2, gy: by * 2 - 1 }, { gx: (bx + 1) * 2 + 1, gy: by * 2 - 1 }]);
    w.autopilot._updateShovels();
    const mv = w.autopilot._shovelMove.get(hex);
    expect(mv).toBeTruthy();
    expect(Math.floor(mv.gx / 2)).toBe(bx + 1);        // chose the truck-accessible block
    expect(Math.floor(mv.gy / 2)).toBe(by);
  });

  it('pulls an idle shovel OFF the road when it has nothing to dig', () => {
    const w = new World();
    const hex = w.byLabel.get('HEX01');
    // strip all ore (nothing to relocate to) and lay a road under the shovel
    for (const row of w.mine.blocks) for (const b of row) { b.explored = true; b.ore = null; b.oreRemaining = 0; }
    w.setRoads([{ gx: hex.gx, gy: hex.gy }]);
    expect(w.autopilot._footprintRoadCount(hex, hex.gx, hex.gy)).toBeGreaterThan(0);   // currently on the road
    w.autopilot._updateShovels();
    const mv = w.autopilot._shovelMove.get(hex);
    expect(mv && mv.aside).toBe(true);                                                  // an "aside" move
    expect(w.autopilot._footprintRoadCount(hex, mv.gx, mv.gy)).toBe(0);                 // target clears the road
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
    const small = sizedParkingRect(w.grid, 4);      // default fleet fits the base pad
    expect(small.w * Math.ceil(small.h / 2)).toBeGreaterThanOrEqual(6);
    const big = sizedParkingRect(w.grid, 40);       // needs 60 slots → must grow
    expect(big.w * Math.ceil(big.h / 2)).toBeGreaterThanOrEqual(60);
  });

  it('keeps every slot footprint (body + rear cell) inside the pad', () => {
    // Bottom-anchored ranks: a parked truck's rear cell must never spill onto a
    // road running along the pad's lower edge.
    for (const p of [{ x: 3, y: 2, w: 6, h: 3 }, { x: 0, y: 0, w: 4, h: 5 }, { x: 2, y: 2, w: 3, h: 2 }]) {
      const slots = padSlots(p);
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        expect(s.gy).toBeGreaterThanOrEqual(p.y);
        expect(s.gy + 1).toBeLessThan(p.y + p.h);      // rear cell inside too
      }
    }
  });

  it('never assigns a slot squatted by another stationary vehicle', () => {
    const w = new World();
    const oht = w.byLabel.get('OHT01');
    oht.gx = oht.tgx = 20; oht.gy = oht.tgy = 20; oht.moving = false; oht.place(w.grid);
    const lv = w.byLabel.get('LV01');                  // the pickup parks right on OHT01's old slot
    lv.gx = lv.tgx = 3; lv.gy = lv.tgy = 3; lv.moving = false; lv.place(w.grid);
    const s = w.autopilot._parkSlot(oht);
    expect(s).toBeTruthy();
    expect(`${s.gx},${s.gy}`).not.toBe('3,3');         // picked a different, genuinely free slot
  });

  it('a truck with no free slot waits off-road beside the pad, never blocking a road', () => {
    const w = new World();
    const ap = w.autopilot;
    const oht = w.byLabel.get('OHT01');
    const st = ap.state.get(oht);
    st.phase = 'to_parking';
    ap._parkSlot = () => null;                         // pretend the pad is completely full
    for (let i = 0; i < 800; i++) w.tick(1 / 30);
    expect(st.overPark).toBeTruthy();                  // it picked a waiting spot…
    expect(oht.gx).toBe(st.overPark.gx);               // …reached it…
    expect(oht.gy).toBe(st.overPark.gy);
    for (const c of oht.collisionCells(oht.gx, oht.gy, w.grid))
      expect(w.roads.isRoad(c.gx, c.gy)).toBe(false);  // …and sits fully clear of the network
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

describe('World — breakdowns', () => {
  it('breaks a shovel/truck on demand, freezes it, and emits an alert + fields', () => {
    const w = new World();
    w.liveDelta();                                   // drain the initial frame
    const label = w.testBreakdown();
    const v = w.byLabel.get(label);
    expect(['oht', 'excavator']).toContain(v.type);
    expect(v.broken).toBe(true);
    const d = w.liveDelta();
    expect(d.breakdowns).toEqual([{ label, type: v.type, x: v.x, y: v.y }]);
    expect(d.vehicles.find((x) => x.id === v.id).broken).toBe(true);
    // frozen: it does not move no matter how long we tick
    const [x, y] = [v.x, v.y];
    for (let i = 0; i < 60; i++) w.tick(1 / 30);
    expect([v.x, v.y]).toEqual([x, y]);
    expect(v.broken).toBe(true);
  });

  it('repairs only when a light vehicle is parked alongside, taking REPAIR_TIME', () => {
    const w = new World();
    const v = w.byLabel.get('HEX01');                 // a shovel, well clear of the parking
    w._breakAsset(v);
    expect(v.broken).toBe(true);
    const lv = w.byLabel.get('LV01');
    lv.manual = true; w.autopilot.setManual(lv);

    // light vehicle parked far away → not adjacent → it stays broken, no progress
    lv.gx = w.grid.zoneCols - 2; lv.gy = w.grid.zoneRows - 2; lv.place(w.grid);
    expect(w._lightVehicleAdjacent(v)).toBe(false);
    for (let i = 0; i < 30 * 2; i++) w.tick(1 / 30);
    expect(v.broken).toBe(true);
    expect(v.repair).toBe(0);

    // park the LV right against the shovel body → repaired after ~REPAIR_TIME seconds
    const cell = v.occupiedCells(w.grid)[0];
    lv.gx = cell.gx; lv.gy = cell.gy - 1; lv.place(w.grid);
    expect(w._lightVehicleAdjacent(v)).toBe(true);
    let secs = 0;
    for (let i = 0; i < 30 * 8 && v.broken; i++) { w.tick(1 / 30); secs += 1 / 30; }
    expect(v.broken).toBe(false);
    expect(secs).toBeGreaterThanOrEqual(REPAIR_TIME - 0.2);
    expect(secs).toBeLessThan(REPAIR_TIME + 1);
  });

  it('only shovels and haul trucks break (not the scout / dozer / grader)', () => {
    const w = new World();
    for (let i = 0; i < 50; i++) w.testBreakdown();   // break everything breakable
    for (const v of w.vehicles) {
      if (v.type === 'pickup' || v.type === 'dozer' || v.type === 'grader') expect(v.broken).toBe(false);
    }
  });
});
