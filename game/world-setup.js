// World generation / initial placement helpers, factored out of World.reset().
// These are the one-shot "lay out the starting world" routines — crusher
// scatter, parking sizing, fleet line-up, and the demo haul circuit — kept
// separate from the per-tick simulation so World stays focused on the loop.
//
// Dependencies (grid / roads / mine) are passed in explicitly rather than read
// off `this`, which makes each routine independently testable.

const { setOre } = require('./mine');
const { COLS, ROWS, PARKING, PARK_HEADING, PARK_BLOCKS, padSlots } = require('./constants');

// Chebyshev block distance from (bx,by) to the parking footprint (0 inside it).
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

// Grow the default parking rect until it can hold ~1.5× the fleet, clamped to
// the sub-zone grid.
function sizedParkingRect(grid, n) {
  const needed = Math.ceil(n * 1.5);
  const { x, y } = PARKING;
  let { w, h } = PARKING;
  // Real slot capacity: ranks are two rows apart AND fully inside the pad
  // (body + rear cell), so a pad holds w × floor(h/2) trucks.
  const capacity = () => padSlots({ x, y, w, h }).length;
  let guard = 0;
  while (capacity() < needed && guard++ < 200) {
    if (w < 10 && w + x < grid.zoneCols - 1) w += 1;
    else if (h + y < grid.zoneRows - 1) h += 2;
    else break;
  }
  return { x, y, w, h };
}

// Line the trucks up nose-up on the parking's slot grid, left-to-right / top-to-
// bottom — so the default fleet starts neatly "en bataille".
function placeTrucksInParking(grid, roads, trucks) {
  const slots = [];
  for (const p of roads.parkings) slots.push(...padSlots(p));
  trucks.forEach((t, i) => {
    const s = slots[Math.min(i, slots.length - 1)] || { gx: PARKING.x, gy: PARKING.y };
    t.gx = s.gx; t.gy = s.gy; t.tgx = s.gx; t.tgy = s.gy; t.fromGx = s.gx; t.fromGy = s.gy;
    t.moving = false; t.heading = PARK_HEADING; t.place(grid);
  });
}

// A random demonstration circuit: a one-way rectangular loop hanging off the
// bottom of the parking (so trucks can enter and leave it), with a crusher on
// its lower edge and a little unrevealed ore seeded just inside, near the
// crusher. Returns { cells, crusher } or null if the map is too small.
function buildExampleCircuit(grid, mine, park) {
  const { zoneCols, zoneRows } = grid;
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
    const b = mine.blocks[by]?.[bx];
    if (!b) continue;
    setOre(b, ores[ri(0, ores.length - 1)], ri(10, 20));
    b.explored = false;
  }

  return { cells, crusher };
}

module.exports = {
  blockDistToParking, placeCrushers, sizedParkingRect, placeTrucksInParking, buildExampleCircuit,
};
