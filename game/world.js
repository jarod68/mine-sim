// Authoritative server-side world. ALL gameplay state lives here and is advanced
// by tick(dt): vehicle movement, anti-collision, the haul autopilot, shovel
// relocation, loading/unloading, payouts, dozer vein preparation. The client only
// renders snapshots and sends commands. The simulation primitives live in sibling
// modules (vehicle / roads / autopilot / min-heap / constants); this file is the
// orchestrator: world setup, the tick loop, commands, economy, snapshots.

const { generateMine, rebuildVeins, setOre, BLOCK_TONNAGE } = require('./mine');
const { Vehicle } = require('./vehicle');
const { Roads } = require('./roads');
const { Autopilot } = require('./autopilot');
const { MinHeap } = require('./min-heap');
const {
  VIEW_W, VIEW_H, COLS, ROWS, BLOCKS_PER_CRUSHER,
  STARTING_CREDIT, DRILL_COST, DOZER_PREP_RANGE, ROAD_WEAR_LIMIT, WORN_SPEED_MULT,
  ORE_VALUE, PARKING, PARK_HEADING, PARK_BLOCKS,
  EXCAVATORS, SHOVEL_MIN_BLOCK_DIST, CRUSHER_PRICE, MAX_EXTRA_CRUSHERS, MAX_ASSETS, CATALOG,
  DIRS, key, rectsOverlap,
} = require('./constants');

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
  // `seed` (optional) makes map generation deterministic — used by tests.
  constructor(seed) {
    this._seed = seed;
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
    this.mine = generateMine(COLS, ROWS, this._seed);
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
    this.vehicles.forEach((v, i) => { v.id = i; });   // stable numeric id (binary pos frame)
    this.byLabel = new Map(this.vehicles.map((v) => [v.label, v]));
    this._placeTrucksInParking([oht1, oht2, oht3, oht4]);   // line them up "en bataille"

    this.autopilot = new Autopilot(this.grid, this.roads, {
      getBlock: (bx, by) => this.mine.blocks[by]?.[bx],
      mineBlock: (bx, by, amount) => this._mineBlock(bx, by, amount),
      deliver: (ore, tons, crusherIdx) => this._deliver(ore, tons, crusherIdx),
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

    // Per-vehicle "move to point" orders (vehicle → { gx, gy, path, i, stuck }).
    this._moveTo = new Map();
    // Dozers actively preparing a rich vein (vehicle → { veinId, dir, lastBlock }).
    this._dozerPrep = new Map();
    // Road cells whose degraded state flipped this frame, queued for the broadcast.
    this._roadDirty = new Set();
    this._boughtCrushers = 0;   // extra crushers the player has purchased



    // Delta-broadcast baselines (last values sent to clients).
    this._lastVeh = new Map();    // id → last non-positional fields
    this._lastPos = new Map();    // id → last position signature
    this._lastCredit = null;
    this._payouts = [];        // pending crusher "+$" payout pops to broadcast
    this._debug = new Set();   // labels with debug-path visualisation enabled
    this._gridDirty = true; this._gridJson = null;   // cached mine-grid JSON (persistence)
    this._occ = null;          // collision occupancy index (built each tick)
  }

  // ── persistence ──
  // A complete, JSON-serialisable snapshot of the authoritative state (incl. the
  // hidden ore and the autopilot's durable links). Transient state — distance
  // caches, planned paths, debug overlays, delta baselines — is NOT saved; it is
  // re-derived on restore.
  toSnapshot() {
    const ap = this.autopilot;
    return {
      v: 1,
      credit: this.credit,
      boughtCrushers: this._boughtCrushers,
      crushers: this.crushers,
      parking: this.roads.parkings[0] || PARKING,
      roads: this.roads.serialize(),
      blocks: this.mine.blocks,
      vehicles: this.vehicles.map((v) => v.toSnapshot()),
      links: [...ap.links].map(([t, s]) => [t.label, s.label]),
      manual: [...ap._manual].map((v) => v.label),
      moveTo: [...this._moveTo].map(([v, st]) => [v.label, { gx: st.gx, gy: st.gy }]),
    };
  }

  // Same snapshot, pre-serialised to a JSON string for persistence. The 26k-block
  // mine grid dominates the size but changes only on drill/mine, so its JSON is
  // cached and reused — turning a per-save multi-MB stringify into a tiny one.
  snapshotJson() {
    if (this._gridDirty || this._gridJson == null) {
      this._gridJson = JSON.stringify(this.mine.blocks);
      this._gridDirty = false;
    }
    const snap = this.toSnapshot();
    delete snap.blocks;                       // injected from the cached string below
    const head = JSON.stringify(snap);
    return `${head.slice(0, -1)},"blocks":${this._gridJson}}`;
  }

  static fromSnapshot(snap) {
    const w = new World();
    w._applySnapshot(snap);
    return w;
  }

  // Rebuild the world in place from a snapshot (vehicles snap to their saved cell;
  // the autopilot re-plans from the restored links / move orders).
  _applySnapshot(snap) {
    this.credit = snap.credit ?? STARTING_CREDIT;
    this._boughtCrushers = snap.boughtCrushers || 0;
    this.dirty = new Map();
    this.mine = { cols: COLS, rows: ROWS, blocks: snap.blocks };
    // Back-compat: snapshots saved before the prep-zone→vein rename carry `prepZone`
    // on vein blocks. Without this, rebuildVeins/_updateDozers find no veins and the
    // dozer sweep silently dies on restored old games.
    for (const row of this.mine.blocks)
      for (const b of row)
        if (b && b.prep && b.veinId == null && b.prepZone != null) { b.veinId = b.prepZone; delete b.prepZone; }
    this.mine.veins = rebuildVeins(snap.blocks);   // derived from the per-block prep fields
    this.crushers = snap.crushers || [];

    this.roads = new Roads(this.grid);
    const park = snap.parking || PARKING;
    this.roads.addParking(park.x, park.y, park.w, park.h);
    this.roads.setCrushers(this.crushers);
    this.roads.setNetwork(snap.roads || []);

    this.vehicles = (snap.vehicles || []).map((d) => Vehicle.fromSnapshot(d, this.grid));
    this.vehicles.forEach((v, i) => { v.id = i; });
    this.byLabel = new Map(this.vehicles.map((v) => [v.label, v]));

    this.autopilot = new Autopilot(this.grid, this.roads, {
      getBlock: (bx, by) => this.mine.blocks[by]?.[bx],
      mineBlock: (bx, by, amount) => this._mineBlock(bx, by, amount),
      deliver: (ore, tons, crusherIdx) => this._deliver(ore, tons, crusherIdx),
    });
    for (const v of this.vehicles) if (v.type === 'excavator') this.autopilot.addShovel(v);
    for (const [tl, sl] of snap.links || []) {
      const t = this.byLabel.get(tl), s = this.byLabel.get(sl);
      if (t && s) this.autopilot.assign(t, s);
    }
    for (const lbl of snap.manual || []) { const v = this.byLabel.get(lbl); if (v) { v.manual = true; this.autopilot.setManual(v); } }
    this.autopilot.setEnabled(true);

    for (const v of this.vehicles) if (v.type === 'grader') this.autopilot.addGrader(v);

    this._moveTo = new Map();
    this._dozerPrep = new Map();
    this._roadDirty = new Set();
    for (const [lbl, t] of snap.moveTo || []) this.moveTo(lbl, t.gx, t.gy);

    this._lastVeh = new Map();
    this._lastPos = new Map();
    this._lastCredit = null;
    this._debug = new Set();
    this._gridDirty = true; this._gridJson = null;
    this._occ = null;
  }

  // Smallest parking rectangle (anchored at PARKING) whose "en bataille" slot
  // grid holds `n` trucks plus ≥50% spare capacity. Grows columns first, then
  // rows, never below the default pad. `_buildSlots` lays slots at every column
  // and every other row, so capacity = w · ceil(h/2).
  _sizedParkingRect(n) {
    const needed = Math.ceil(n * 1.5);
    const { x, y } = PARKING;
    let { w, h } = PARKING;
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
    // Occupancy index: one Set of vehicles per cell, so collision queries are
    // O(1) instead of O(n) (the old scan made the whole tick O(n²)). Built from
    // current positions before anyone moves, then kept correct by re-indexing
    // each vehicle right after it moves — matching the old live-scan semantics.
    this._buildOcc();
    const isFree = (gx, gy, self) => {
      const s = this._occ.get(key(gx, gy));
      return !s || s.size === 0 || (s.size === 1 && s.has(self));
    };
    this.autopilot.isFree = isFree;
    this._updateDozers();                           // auto-start + tally dozer prep passes
    this.autopilot.update(dt);
    for (const v of this.vehicles) {
      let dir = null;
      const mv = this._moveStep(v);                 // "move to point" override
      if (mv !== undefined) dir = mv;
      else if (v.manual && v.manualDir) dir = v.manualDir;
      else if (this._dozerPrep.has(v)) dir = this._dozerStep(v);   // preparing a rich vein
      else if (this.autopilot.controls(v)) dir = this.autopilot.dirFor(v);
      // Haul trucks crawl over degraded road segments (only the impacted cells).
      if (v.type === 'oht')
        v.speedMul = (this.roads.isWorn(v.gx, v.gy) || (v.moving && this.roads.isWorn(v.tgx, v.tgy))) ? WORN_SPEED_MULT : 1;
      const pgx = v.gx, pgy = v.gy;
      const oldKeys = this._occKeys(v);
      v.update(dt, dir, this.grid, isRoad, isFree);
      this._reindexOcc(v, oldKeys);
      if (v.gx !== pgx || v.gy !== pgy) this._roadPass(v);   // entered a new cell → wear / repair
    }
  }

  // A vehicle just entered cell (v.gx,v.gy). A grader smooths a degraded road cell
  // back out; any other vehicle wears it a little. Worn-state flips are queued for
  // the live broadcast so clients re-render the affected cell.
  _roadPass(v) {
    if (!this.roads.isRoad(v.gx, v.gy)) return;
    const flipped = v.type === 'grader' ? this.roads.repairCell(v.gx, v.gy) : this.roads.wearPass(v.gx, v.gy);
    if (flipped) this._roadDirty.add(key(v.gx, v.gy));
  }

  // True when anything is (or is about to start) moving — drives the loop's
  // adaptive tick rate (idle rooms tick far less often).
  anyMoving() {
    if (this._moveTo.size > 0 || this._dozerPrep.size > 0) return true;
    for (const v of this.vehicles) if (v.moving) return true;
    return false;
  }

  // ── Dozer prep: reveal rich veins by repeated dozer passes ──────────────────
  // Idle dozers within DOZER_PREP_RANGE blocks of an unfinished vein auto-start;
  // a working dozer tallies one pass per block it enters and reveals a block once
  // it reaches prepMax passes. _dozerStep drives the back-and-forth line sweep.
  _updateDozers() {
    const zones = this.mine.veins;
    if (!zones || !zones.length) return;
    for (const v of this.vehicles) {
      if (v.type !== 'dozer') continue;
      if (v.manual || this._moveTo.has(v)) { this._dozerPrep.delete(v); v._prepLine = null; continue; }
      const bx = Math.floor(v.gx / 2), by = Math.floor(v.gy / 2);
      const st = this._dozerPrep.get(v);
      if (st) {
        const z = zones[st.veinId];
        if (!z || z.remaining <= 0) { this._dozerPrep.delete(v); v._prepLine = null; continue; }
        const k = `${bx},${by}`;
        if (k !== st.lastBlock) {                    // entered a new block → one pass
          st.lastBlock = k;
          const b = this.mine.blocks[by]?.[bx];
          if (b && b.prep && !b.prepDone && b.veinId === st.veinId) {
            b.prepPasses = Math.min(b.prepMax, b.prepPasses + 1);
            if (b.prepPasses >= b.prepMax) this._revealPrep(b, z);
            else this._markDirty(b);
          }
        }
        continue;
      }
      const id = this._nearestVein(bx, by, DOZER_PREP_RANGE);
      if (id != null) this._dozerPrep.set(v, { veinId: id, dir: 1, lastBlock: null });
    }
  }

  _revealPrep(b, z) {
    b.prepDone = true;
    b.explored = true;                               // ore now visible & mineable
    if (z) z.remaining = Math.max(0, z.remaining - 1);
    this._markDirty(b);
  }

  // Zone of the nearest un-revealed vein BLOCK within R blocks (Chebyshev), or
  // null. Scans actual blocks — not bounding boxes — so an irregular zone's empty
  // bbox corners don't trigger (or mis-pick) a start.
  _nearestVein(bx, by, R) {
    let best = null, bestD = Infinity;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const b = this.mine.blocks[by + dy]?.[bx + dx];
        if (!b || !b.prep || b.prepDone) continue;
        const z = this.mine.veins[b.veinId];
        if (!z || z.remaining <= 0) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d < bestD) { bestD = d; best = b.veinId; }
      }
    return best;
  }

  // One step of a dozer's vein sweep: reach the zone's columns, drop to the top
  // unfinished block-row, then sweep back and forth across it (each traversal adds
  // a pass to every block in the row) until the whole zone is revealed.
  _dozerStep(v) {
    const st = this._dozerPrep.get(v);
    if (!st) return null;
    const z = this.mine.veins[st.veinId];
    if (!z || z.remaining <= 0) return null;
    const bx = Math.floor(v.gx / 2), by = Math.floor(v.gy / 2);
    // Topmost block-row still hiding ore, AND that row's own unrevealed span — not
    // the zone bounding box. A narrow row then turns around at its own last block
    // instead of dragging out to the width of the widest row.
    let row = -1, rowMin = Infinity, rowMax = -Infinity;
    for (let ry = z.y0; ry <= z.y1 && row < 0; ry++) {
      let mn = Infinity, mx = -Infinity;
      for (let rx = z.x0; rx <= z.x1; rx++) {
        const b = this.mine.blocks[ry][rx];
        if (b && b.prep && b.veinId === st.veinId && !b.prepDone) { if (rx < mn) mn = rx; if (rx > mx) mx = rx; }
      }
      if (mn !== Infinity) { row = ry; rowMin = mn; rowMax = mx; }
    }
    if (row < 0) { v._prepLine = null; return null; }
    v._prepLine = { y: row, x0: rowMin, x1: rowMax, dir: st.dir };   // for the client overlay
    if (by !== row) {                                // approach the working row, in its span
      if (bx < rowMin) return [1, 0];
      if (bx > rowMax) return [-1, 0];
      return [0, Math.sign(row - by)];
    }
    // Sweep THIS row only, overshooting one block past its own last blocks so every
    // block (edges included) gets a pass in both directions (≈ prepMax/2 round trips).
    let dir = st.dir;
    if (dir > 0 && bx >= rowMax + 1) dir = -1;
    else if (dir < 0 && bx <= rowMin - 1) dir = 1;
    st.dir = dir;
    return [dir, 0];
  }

  _buildOcc() {
    const occ = new Map();
    for (const v of this.vehicles) {
      for (const c of v.occupiedCells(this.grid)) {
        const k = key(c.gx, c.gy);
        let s = occ.get(k); if (!s) occ.set(k, s = new Set());
        s.add(v);
      }
    }
    this._occ = occ;
  }

  _occKeys(v) {
    const out = [];
    for (const c of v.occupiedCells(this.grid)) out.push(key(c.gx, c.gy));
    return out;
  }

  _reindexOcc(v, oldKeys) {
    for (const k of oldKeys) { const s = this._occ.get(k); if (s) { s.delete(v); if (!s.size) this._occ.delete(k); } }
    for (const c of v.occupiedCells(this.grid)) {
      const k = key(c.gx, c.gy);
      let s = this._occ.get(k); if (!s) this._occ.set(k, s = new Set());
      s.add(v);
    }
  }

  // O(n) freeness scan — kept for direct/external use (tests, off-tick checks).
  // The hot tick path uses the O(1) index above.
  _isFree(gx, gy, self) {
    for (const v of this.vehicles) {
      if (v === self) continue;
      for (const c of v.occupiedCells(this.grid)) if (c.gx === gx && c.gy === gy) return false;
    }
    return true;
  }

  // ── gameplay hooks ──
  _markDirty(b) { this.dirty.set(`${b.x},${b.y}`, b); this._gridDirty = true; }

  _mineBlock(bx, by, amount) {
    const block = this.mine.blocks[by]?.[bx];
    if (!block || !block.explored) return 0;
    const want = Math.max(0, Math.floor(Number(amount) || 0));
    const mined = Math.min(want, block.oreRemaining);
    block.oreRemaining -= mined;
    this._markDirty(block);
    return mined;
  }

  _deliver(ore, tons, crusherIdx) {
    const t = Math.max(0, Math.floor(Number(tons) || 0));
    const rate = ORE_VALUE[ore] || 0;
    const amount = Math.round(rate * t);
    this.credit += amount;
    // Queue a floating "+$" pop over the crusher that received the load.
    if (amount > 0) {
      const cr = this.crushers[crusherIdx] || this.crushers[0];
      if (cr) this._payouts.push({ gx: cr.x + cr.w / 2, gy: cr.y + cr.h / 2, amount });
    }
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
    if (block.prep && !block.prepDone) return { error: 'requires dozer preparation', credit: this.credit };
    if (block.explored) return { block, credit: this.credit };
    if (this.credit < DRILL_COST) return { error: 'insufficient credit', credit: this.credit };
    this.credit -= DRILL_COST;
    block.explored = true;
    this._markDirty(block);
    return { block, credit: this.credit };
  }

  // True when sub-zone cell (gx,gy) lies on a rich vein block the dozer hasn't
  // revealed yet — no road may be laid there until it's prepared.
  _onUnpreparedVein(gx, gy) {
    const b = this.mine.blocks[Math.floor(gy / 2)]?.[Math.floor(gx / 2)];
    return !!(b && b.prep && !b.explored);
  }

  setRoads(cells) {
    // Drop any cell on an un-prepared rich vein — roads can't cross it until the
    // dozer has revealed the ground. The serialized result echoes the drop back.
    const filtered = Array.isArray(cells) ? cells.filter((c) => !this._onUnpreparedVein(c.gx, c.gy)) : cells;
    this.roads.setNetwork(filtered);
    this.autopilot.invalidateRoadCaches();   // road change → re-plan crusher bays + routes
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

    this.autopilot.invalidateSlots();        // rebuild the parking slot grid lazily
    this.autopilot.invalidateRoadCaches();
    return { x, y, w, h };
  }

  control(label, { dir, release } = {}) {
    const v = this.byLabel.get(label);
    if (!v) return;
    this._moveTo.delete(v);                 // any manual input cancels a move order
    if (release) {
      // Deselecting hands any asset back to the autopilot — a shovel that was
      // driven manually resumes its automatic relocation once released.
      v.manual = false; v.manualDir = null; v.offroad = false;
      this.autopilot.clearManual(v);
      return;
    }
    v.manual = true;
    v.manualDir = Array.isArray(dir) ? dir : null;
    this.autopilot.setManual(v);
  }

  // ── "Move to point" ──────────────────────────────────────────────────────────
  // Send a vehicle to a sub-zone cell via the shortest path, preferring roads but
  // cutting off-road when necessary. Works for any vehicle type and takes over
  // from both the haul autopilot and manual driving until it arrives.
  moveTo(label, gx, gy) {
    const v = this.byLabel.get(label);
    if (!v) return;
    const { zoneCols, zoneRows } = this.grid;
    gx = Math.max(0, Math.min(zoneCols - 1, Math.round(Number(gx))));
    gy = Math.max(0, Math.min(zoneRows - 1, Math.round(Number(gy))));
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    v.manual = false; v.manualDir = null;
    this.autopilot.setManual(v);            // pause hauling/relocation while it drives there
    const path = this._planMovePath(v, gx, gy);
    if (!path || path.length <= 1) { this._moveTo.delete(v); this.autopilot.clearManual(v); v.offroad = false; return; }
    this._moveTo.set(v, { gx, gy, path, i: 1, stuck: 0, from: null });
  }

  // Drive one step of an active move order, or undefined if the vehicle has none.
  _moveStep(v) {
    const st = this._moveTo.get(v);
    if (!st) return undefined;
    v.offroad = true;                       // road-only trucks may leave the road for this
    if (v.moving) return null;              // finish the current hop (update lerps it)
    const cur = { gx: v.gx, gy: v.gy };
    if (cur.gx === st.gx && cur.gy === st.gy) { this._endMove(v); return null; }

    // Stuck detection: if we didn't move since the last order, count it.
    if (st.from && st.from.gx === cur.gx && st.from.gy === cur.gy) st.stuck++; else st.stuck = 0;
    while (st.i < st.path.length && st.path[st.i].gx === cur.gx && st.path[st.i].gy === cur.gy) st.i++;
    if (st.i >= st.path.length) { this._endMove(v); return null; }
    if (st.stuck > 18) {                    // blocked → replan around it, or give up
      const path = this._planMovePath(v, st.gx, st.gy);
      if (!path || path.length <= 1) { this._endMove(v); return null; }
      st.path = path; st.i = 1; st.stuck = 0;
    }
    const next = st.path[st.i];
    st.from = cur;
    return [Math.sign(next.gx - cur.gx), Math.sign(next.gy - cur.gy)];
  }

  _endMove(v) {
    this._moveTo.delete(v);
    v.offroad = false;
    this.autopilot.clearManual(v);          // resume hauling / shovel relocation
  }

  // Weighted A* over the sub-zone grid from the vehicle to (tgx,tgy). Road cells
  // cost 1, off-road cells more, so the route sticks to roads and only cuts
  // off-road where it must. Crusher footprints are walls. Returns a cell path
  // (start→target) or null if unreachable.
  _planMovePath(v, tgx, tgy) {
    const { zoneCols, zoneRows } = this.grid;
    const sgx = v.moving ? v.tgx : v.gx;
    const sgy = v.moving ? v.tgy : v.gy;
    if (sgx === tgx && sgy === tgy) return null;
    const walls = this._crusherCells();
    walls.delete(key(tgx, tgy));            // allow targeting onto a crusher edge
    if (walls.has(key(tgx, tgy))) return null;
    // Cells currently occupied by OTHER vehicles — strongly avoided so the route
    // goes around them, but not forbidden (they move; per-step waiting/replanning
    // handles the rest).
    const occ = new Set();
    for (const o of this.vehicles) {
      if (o === v) continue;
      for (const c of o.occupiedCells(this.grid)) occ.add(key(c.gx, c.gy));
    }
    occ.delete(key(tgx, tgy));
    const OFFROAD = 4;                      // off-road step cost (roads cost 1)
    const BUSY = 60;                        // penalty for a cell another vehicle holds
    const id = (gx, gy) => gy * zoneCols + gx;
    const g = new Map();
    const came = new Map();
    const open = new MinHeap();
    const sId = id(sgx, sgy);
    g.set(sId, 0);
    open.push({ f: Math.abs(tgx - sgx) + Math.abs(tgy - sgy), g: 0, id: sId, gx: sgx, gy: sgy });

    let found = null, guard = 0;
    while (open.size && guard++ < 120000) {
      const cur = open.pop();
      if (cur.g > (g.get(cur.id) ?? Infinity)) continue;   // stale heap entry
      if (cur.gx === tgx && cur.gy === tgy) { found = cur.id; break; }
      for (const [dx, dy] of DIRS) {
        const nx = cur.gx + dx, ny = cur.gy + dy;
        if (nx < 0 || ny < 0 || nx >= zoneCols || ny >= zoneRows) continue;
        if (walls.has(key(nx, ny))) continue;
        const k = key(nx, ny);
        const ng = cur.g + (this.roads.isRoad(nx, ny) ? 1 : OFFROAD) + (occ.has(k) ? BUSY : 0);
        const nId = id(nx, ny);
        if (ng >= (g.get(nId) ?? Infinity)) continue;
        g.set(nId, ng);
        came.set(nId, cur.id);
        open.push({ f: ng + Math.abs(tgx - nx) + Math.abs(tgy - ny), g: ng, id: nId, gx: nx, gy: ny });
      }
    }
    if (found === null) return null;
    const path = [];
    for (let i = found; i !== undefined; i = came.get(i)) path.push({ gx: i % zoneCols, gy: Math.floor(i / zoneCols) });
    return path.reverse();
  }

  _crusherCells() {
    const s = new Set();
    for (const c of this.crushers)
      for (let gy = c.y; gy < c.y + c.h; gy++)
        for (let gx = c.x; gx < c.x + c.w; gx++) s.add(key(gx, gy));
    return s;
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
    } else if (item.type === 'dozer') {
      // Same proportions as the R9400 shovel, a touch smaller.
      v = new Vehicle({ type: 'dozer', label: this._nextLabel('DZ'), gx: cell.gx, gy: cell.gy, len: zone * 1.1, wid: zone * 0.87, model: item.model });
    } else if (item.type === 'grader') {
      // As long as a T264 haul truck but half as wide.
      v = new Vehicle({ type: 'grader', label: this._nextLabel('GR'), gx: cell.gx, gy: cell.gy, len: zone * 1.445, wid: zone * 0.35, model: item.model });
      this.autopilot.addGrader(v);
    } else {
      v = new Vehicle({ type: 'pickup', label: this._nextLabel('LV'), gx: cell.gx, gy: cell.gy, len: zone * 0.95, wid: zone * 0.57 });
    }
    // Trucks/LV spawn nose-up in their parking slot, neatly "en bataille".
    if (item.type === 'oht' || item.type === 'pickup') v.heading = PARK_HEADING;
    v.place(this.grid);
    v.id = this.vehicles.length;          // stable id = append index
    this.vehicles.push(v);
    this.byLabel.set(v.label, v);
    return { ok: true, credit: this.credit, label: v.label, vehicle: this._vehicle(v) };
  }

  // Buy and place an extra crusher (2×2 sub-zones) at (gx,gy). Up to
  // MAX_EXTRA_CRUSHERS, CRUSHER_PRICE each. Rejected if out of slots, unaffordable,
  // or overlapping the parking / another crusher. Returns { ok, credit, crusher,
  // extraCrushers } or { error, credit }.
  buyCrusher(gx, gy) {
    if (this._boughtCrushers >= MAX_EXTRA_CRUSHERS) return { error: 'max', credit: this.credit };
    if (this.credit < CRUSHER_PRICE) return { error: 'credit', credit: this.credit };
    const { zoneCols, zoneRows } = this.grid;
    const x = Math.max(0, Math.min(zoneCols - 2, Math.round(Number(gx))));
    const y = Math.max(0, Math.min(zoneRows - 2, Math.round(Number(gy))));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'invalid', credit: this.credit };
    const rect = { x, y, w: 2, h: 2 };
    const p = this.roads.parkings[0];
    if (p && rectsOverlap(rect, p)) return { error: 'blocked', credit: this.credit };
    for (const c of this.crushers) if (rectsOverlap(rect, c)) return { error: 'blocked', credit: this.credit };

    this.credit -= CRUSHER_PRICE;
    this._boughtCrushers += 1;
    this.crushers.push(rect);
    this.roads.setCrushers(this.crushers);
    this.autopilot.invalidateRoadCaches();   // new dump bays + routes
    return { ok: true, credit: this.credit, crusher: rect, extraCrushers: this._boughtCrushers };
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
      const pads = this.roads.parkings && this.roads.parkings.length ? this.roads.parkings : [P];
      // Prefer a tidy "en bataille" slot — nose-up, ranks two cells apart so a
      // truck's body clears the rank in front. A 3-tall pad holds two ranks; taller
      // pads add more. A freshly-bought truck therefore spawns already well-parked.
      for (const p of pads)
        for (let gy = p.y; gy <= p.y + p.h - 1; gy += 2)
          for (let gx = p.x; gx < p.x + p.w; gx++)
            if (!occ(gx, gy)) return { gx, gy };
      // Every rank slot taken → fall back to any free cell inside the pad.
      for (const p of pads)
        for (let gy = p.y; gy < p.y + p.h; gy++)
          for (let gx = p.x; gx < p.x + p.w; gx++)
            if (!occ(gx, gy)) return { gx, gy };
    }
    // A new shovel must keep ≥ SHOVEL_MIN_BLOCK_DIST blocks from every other
    // shovel, so two are never generated on top of one another.
    const clearOfShovels = (gx, gy) => {
      if (type !== 'excavator') return true;
      const bx = Math.floor(gx / 2), by = Math.floor(gy / 2);
      for (const v of this.vehicles) {
        if (v.type !== 'excavator') continue;
        const sbx = Math.floor(v.gx / 2), sby = Math.floor(v.gy / 2);
        if (Math.max(Math.abs(bx - sbx), Math.abs(by - sby)) < SHOVEL_MIN_BLOCK_DIST) return false;
      }
      return true;
    };
    const cx = P.x + Math.floor(P.w / 2);
    const cy = P.y + P.h + 1;
    for (let r = 0; r < 100; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring perimeter
          const gx = cx + dx;
          const gy = cy + dy;
          if (gx < 0 || gy < 0 || gx >= this.grid.zoneCols || gy >= this.grid.zoneRows) continue;
          if (!occ(gx, gy) && clearOfShovels(gx, gy)) return { gx, gy };
        }
    }
    return { gx: P.x, gy: P.y };
  }

  // ── snapshots ──
  _publicBlock(b) {
    if (b.explored) return b;
    if (b.prep) return { x: b.x, y: b.y, explored: false, prep: true, prepPasses: b.prepPasses, prepMax: b.prepMax };
    return { x: b.x, y: b.y, explored: false };
  }

  _vehicle(v) {
    return {
      id: v.id, label: v.label, type: v.type, model: v.model,
      gx: v.gx, gy: v.gy, x: v.x, y: v.y, heading: v.heading,
      len: v.len, wid: v.wid,
      load: v.load, loadOre: v.loadOre, payload: v.payload, bucket: v.bucket,
      task: v.task, digging: v.digging, manual: v.manual,
      shovel: v.type === 'oht' ? (this.autopilot.assignedShovel(v)?.label ?? null) : null,
      prepLine: prepLineStr(v),
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
      crusherPrice: CRUSHER_PRICE,
      extraCrushers: this._boughtCrushers,
      maxExtraCrushers: MAX_EXTRA_CRUSHERS,
      roads: this.roads.serialize(),
      vehicles: this.vehicles.map((v) => this._vehicle(v)),
      // Only the "significant" blocks (explored or a rich vein) — the client
      // defaults the rest to unexplored. Cuts the initial snapshot from the whole
      // 26k-block grid to the small revealed/vein subset.
      blocks: this._significantBlocks(),
    };
  }

  // Flat list of blocks worth sending: explored (revealed composition) or part of
  // a rich vein (rendered specially). Everything else is implicitly unexplored.
  _significantBlocks() {
    const out = [];
    for (const row of this.mine.blocks)
      for (const b of row) if (b.explored || b.prep) out.push(this._publicBlock(b));
    return out;
  }

  // Dynamic NON-positional fields that may change tick to tick. Position
  // (x/y/heading/gx/gy) travels in the compact binary `pos` frame instead — see
  // positionsDelta() — so the JSON delta only carries the rarely-changing rest.
  _vehFields(v) {
    return {
      id: v.id,
      load: Math.round(v.load),
      loadOre: v.loadOre,
      task: v.task ? { kind: v.task.kind, progress: Math.round(v.task.progress * 100) / 100 } : null,
      digging: v.digging,
      manual: v.manual,
      shovel: v.type === 'oht' ? (this.autopilot.assignedShovel(v)?.label ?? null) : null,
      prepLine: prepLineStr(v),
    };
  }

  // Binary frame of every vehicle whose position changed since the last call:
  // [u8 type=1][u16 count]{ u16 id, f32 x, f32 y, f32 heading, u16 gx, u16 gy }.
  // Returns a Buffer, or null when nothing moved. ~18 bytes/vehicle vs verbose JSON.
  positionsDelta() {
    const recs = [];
    for (const v of this.vehicles) {
      const sig = `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.heading * 1000)},${v.gx},${v.gy}`;
      if (this._lastPos.get(v.id) === sig) continue;
      this._lastPos.set(v.id, sig);
      recs.push(v);
    }
    if (!recs.length) return null;
    const buf = Buffer.allocUnsafe(3 + recs.length * 18);
    buf.writeUInt8(1, 0);
    buf.writeUInt16LE(recs.length, 1);
    let o = 3;
    for (const v of recs) {
      buf.writeUInt16LE(v.id, o); o += 2;
      buf.writeFloatLE(v.x, o); o += 4;
      buf.writeFloatLE(v.y, o); o += 4;
      buf.writeFloatLE(v.heading, o); o += 4;
      buf.writeUInt16LE(v.gx, o); o += 2;
      buf.writeUInt16LE(v.gy, o); o += 2;
    }
    return buf;
  }

  // Delta snapshot: only vehicles whose fields changed (and only those fields),
  // credit only if it changed, plus any blocks touched since last call. Returns
  // null when nothing changed at all, so the server can skip the frame entirely.
  liveDelta() {
    const vehicles = [];
    for (const v of this.vehicles) {
      const cur = this._vehFields(v);
      const prev = this._lastVeh.get(v.id);
      this._lastVeh.set(v.id, cur);
      if (!prev) { vehicles.push(cur); continue; } // first time → send all fields
      let d = null;
      for (const k in cur) {
        if (k === 'id') continue;
        if (!fieldEq(cur[k], prev[k])) (d ||= { id: cur.id })[k] = cur[k];
      }
      if (d) vehicles.push(d);
    }

    const blocks = [...this.dirty.values()].map((b) => this._publicBlock(b));
    this.dirty.clear();

    const creditChanged = this.credit !== this._lastCredit;
    this._lastCredit = this.credit;

    const payouts = this._payouts.length ? this._payouts : null;
    if (payouts) this._payouts = [];

    let roads = null;
    if (this._roadDirty.size) {
      roads = [...this._roadDirty].map((k) => {
        const [gx, gy] = k.split(',').map(Number);
        return { gx, gy, worn: this.roads.isWorn(gx, gy) };
      });
      this._roadDirty.clear();
    }

    if (!vehicles.length && !blocks.length && !creditChanged && !payouts && !roads) return null;
    const msg = { vehicles, blocks };
    if (creditChanged) msg.credit = this.credit;
    if (payouts) msg.payouts = payouts;
    if (roads) msg.roads = roads;
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
// Compact, value-comparable encoding of a dozer's current sweep line for deltas
// ("y,x0,x1,dir" or null) — the client draws the violet path + return arrow.
function prepLineStr(v) {
  const p = v._prepLine;
  return p ? `${p.y},${p.x0},${p.x1},${p.dir}` : null;
}

function fieldEq(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return a.kind === b.kind && a.progress === b.progress;
  return false;
}


module.exports = {
  World, Vehicle, Roads, Autopilot,
  VIEW_W, VIEW_H, COLS, ROWS, DRILL_COST,
  ROAD_WEAR_LIMIT, WORN_SPEED_MULT,
};
