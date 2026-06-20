// Server-side mine model + gameplay logic (authoritative).
//
// A mine is a grid of mining blocks. Each block weighs BLOCK_TONNAGE tonnes
// (dirt + at most one ore type, the two percentages summing to 100). Ore is laid
// out in CONTIGUOUS deposits. A block's composition stays hidden until it is
// drilled (`explored`). The client never receives unexplored composition.

const ORE_TYPES = ['iron', 'copper', 'gold', 'carbon'];

// Human labels are presentation-only and live on the client (public/components/
// mine.js) — the server never sends them, so it doesn't carry a copy.

const BLOCK_TONNAGE = 10000;

// Weighted draw so gold stays rare and iron is common.
const ORE_WEIGHTED = [
  'iron', 'iron', 'iron',
  'copper', 'copper',
  'carbon', 'carbon',
  'gold',
];

// Per-ore richness ceiling (percent of the block).
const ORE_MAX = { iron: 55, copper: 50, carbon: 60, gold: 15 };

// Roughly what share of the map ends up carrying ore.
const ORE_COVERAGE = 0.45;

// Rich "prep" veins: very rich, HIDDEN ore that a drill can't touch — they must
// be worked by a dozer (PREP_PASSES passes per block) before the ore is revealed.
// Zones are organic blobs (irregular outline, varying width/height) but all share
// the SAME area. See game/world.js for the dozer mechanic.
const VEIN_AREA = 150;   // blocks per zone (all zones equal; ~ old 10×15)
const VEIN_COUNT = 10;   // zones per map
const PREP_PASSES = 10;       // dozer passes needed to reveal each block
// Rich veins skew toward valuable ore.
const PREP_ORE_WEIGHTED = ['gold', 'gold', 'copper', 'copper', 'carbon', 'iron'];

// Pluggable RNG so generation can be made deterministic (seeded) in tests. All
// helpers below draw from `rng`; generateMine sets it for the duration of a build.
let rng = Math.random;
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// Small deterministic PRNG (mulberry32) used when a seed is supplied.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyBlock(x, y) {
  return {
    x,
    y,
    explored: false,
    ore: null,
    orePct: 0,
    dirtPct: 100,
    dirtRemaining: BLOCK_TONNAGE,
    oreRemaining: 0,
    tonnage: BLOCK_TONNAGE,
    // 4 sub-zones (top-left, top-right, bottom-left, bottom-right).
    zones: [null, null, null, null],
  };
}

function setOre(block, ore, orePct) {
  block.ore = ore;
  block.orePct = orePct;
  block.dirtPct = 100 - orePct;
  block.oreRemaining = Math.round((BLOCK_TONNAGE * orePct) / 100);
  block.dirtRemaining = BLOCK_TONNAGE - block.oreRemaining;
}

// Grow one contiguous ore deposit via random frontier expansion.
function growDeposit(mine, ore, size) {
  const { cols, rows, blocks } = mine;

  let seed = null;
  for (let t = 0; t < 40 && !seed; t++) {
    const x = randInt(0, cols - 1);
    const y = randInt(0, rows - 1);
    if (!blocks[y][x].ore) seed = { x, y };
  }
  if (!seed) return 0;

  const ceil = ORE_MAX[ore];
  const frontier = [seed];
  let assigned = 0;

  while (assigned < size && frontier.length) {
    const [{ x, y }] = frontier.splice(randInt(0, frontier.length - 1), 1);
    const block = blocks[y][x];
    if (block.ore) continue;

    setOre(block, ore, Math.max(1, randInt(8, ceil)));
    assigned++;

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !blocks[ny][nx].ore) {
        frontier.push({ x: nx, y: ny });
      }
    }
  }
  return assigned;
}

// Stamp VEIN_COUNT rich veins onto the grid. Each is an organic blob of
// exactly VEIN_AREA connected blocks (grown by random frontier expansion, so
// the outline is irregular and width/height vary) kept a block clear of every
// other zone. Each block gets rich, hidden ore and prep bookkeeping. Returns the
// zones' bounding boxes (with a live `remaining` un-revealed count).
function placeVeins(mine) {
  const { cols, rows, blocks } = mine;
  const zones = [];
  // No room for a zone of this area (e.g. tiny test maps) → none.
  if (cols < 24 || rows < 24 || cols * rows < VEIN_AREA * VEIN_COUNT * 3) {
    mine.veins = zones; return zones;
  }
  // Stay clear of the top-left spawn / parking / demo-circuit area.
  const keepOut = { x0: 0, y0: 0, x1: 46, y1: 26 };
  const inKeepOut = (x, y) => x >= keepOut.x0 && x <= keepOut.x1 && y >= keepOut.y0 && y <= keepOut.y1;
  const claim = new Map();                 // "x,y" → veinId (blocks already taken)
  const inBounds = (x, y) => x >= 1 && y >= 1 && x < cols - 1 && y < rows - 1;
  const adjOther = (x, y, id) => {         // touches a DIFFERENT zone? → keep a 1-block gap
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = claim.get(`${x + dx},${y + dy}`);
        if (o != null && o !== id) return true;
      }
    return false;
  };
  const free = (x, y, id) => inBounds(x, y) && !inKeepOut(x, y) && !claim.has(`${x},${y}`) && !adjOther(x, y, id);

  let guard = 0;
  while (zones.length < VEIN_COUNT && guard++ < 400) {
    const id = zones.length;
    let seed = null;
    for (let t = 0; t < 300 && !seed; t++) {
      const x = randInt(2, cols - 3), y = randInt(2, rows - 3);
      if (free(x, y, id)) seed = { x, y };
    }
    if (!seed) continue;

    // Grow a connected blob of VEIN_AREA cells.
    const cells = [];
    const taken = [];
    const frontier = [seed];
    while (cells.length < VEIN_AREA && frontier.length) {
      const { x, y } = frontier.splice(randInt(0, frontier.length - 1), 1)[0];
      if (!free(x, y, id)) continue;
      claim.set(`${x},${y}`, id); taken.push(`${x},${y}`); cells.push({ x, y });
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) frontier.push({ x: x + dx, y: y + dy });
    }
    if (cells.length < VEIN_AREA) { for (const k of taken) claim.delete(k); continue; }   // boxed in → retry

    const ore = PREP_ORE_WEIGHTED[randInt(0, PREP_ORE_WEIGHTED.length - 1)];
    const ceil = ORE_MAX[ore];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { x, y } of cells) {
      const b = blocks[y][x];
      b.prep = true; b.veinId = id; b.prepPasses = 0; b.prepMax = PREP_PASSES; b.prepDone = false;
      b.explored = false;
      setOre(b, ore, randInt(Math.round(ceil * 0.7), ceil));   // rich, hidden
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    zones.push({ x0, y0, x1, y1, remaining: cells.length });
  }
  mine.veins = zones;
  return zones;
}

// Rebuild the zone rectangles (+ live remaining count) from a restored grid, so
// snapshots only need to carry the per-block prep fields.
function rebuildVeins(blocks) {
  const byId = new Map();
  for (const row of blocks)
    for (const b of row) {
      if (!b || !b.prep) continue;
      let z = byId.get(b.veinId);
      if (!z) byId.set(b.veinId, z = { x0: b.x, y0: b.y, x1: b.x, y1: b.y, remaining: 0 });
      z.x0 = Math.min(z.x0, b.x); z.y0 = Math.min(z.y0, b.y);
      z.x1 = Math.max(z.x1, b.x); z.y1 = Math.max(z.y1, b.y);
      if (!b.prepDone) z.remaining++;
    }
  const zones = [];
  for (const [id, z] of byId) zones[id] = z;
  return zones;
}

// `seed` (optional) makes the whole layout deterministic — pass it from tests for
// reproducible maps; omit it in production for a fresh map every game.
function generateMine(cols, rows, seed) {
  const prev = rng;
  if (seed != null) rng = mulberry32(seed);
  try {
    const blocks = [];
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) row.push(emptyBlock(x, y));
      blocks.push(row);
    }
    const mine = { cols, rows, blocks };

    const target = Math.floor(cols * rows * ORE_COVERAGE);
    let oreCells = 0;
    let guard = 0;
    while (oreCells < target && guard++ < 1200) {
      const ore = ORE_WEIGHTED[randInt(0, ORE_WEIGHTED.length - 1)];
      oreCells += growDeposit(mine, ore, randInt(6, 16));
    }

    placeVeins(mine);
    return mine;
  } finally {
    rng = prev;
  }
}

module.exports = {
  generateMine,
  rebuildVeins,
  setOre,
  BLOCK_TONNAGE,
  ORE_TYPES,
  PREP_PASSES,
  VEIN_AREA,
  VEIN_COUNT,
};
