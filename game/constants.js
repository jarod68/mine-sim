// Shared gameplay constants and tiny helpers for the authoritative simulation.
// Split out of world.js so every game module (vehicle, roads, autopilot, world)
// reads the same single source.

// View space shared with the client renderer (so x/y come ready to draw).
// Map area ×15 of the original (×5 of the previous), view scaled to keep the
// block/vehicle size constant.
const VIEW_W = 7942;
const VIEW_H = 5560;
const COLS = 190;
const ROWS = 139;

// One crusher per ~5000 blocks on average.
const BLOCKS_PER_CRUSHER = 5000;

const STARTING_CREDIT = 100000;
const DRILL_COST = 5000;

// A dozer auto-starts preparing a rich vein when idle within this many blocks of it.
const DOZER_PREP_RANGE = 5;

const ORE_VALUE = {
  iron:   10000 / 240,
  copper: 16000 / 240,
  gold:   60000 / 240,
  carbon:  6000 / 240,
};

const PARKING = { x: 3, y: 2, w: 6, h: 3 };
// Parked trucks all face up (nose toward -y), lined up "en bataille".
const PARK_HEADING = -Math.PI / 2;
const PARK_BLOCKS = {
  bx0: Math.floor(PARKING.x / 2),
  by0: Math.floor(PARKING.y / 2),
  bx1: Math.floor((PARKING.x + PARKING.w - 1) / 2),
  by1: Math.floor((PARKING.y + PARKING.h - 1) / 2),
};

const BASE_SPEED = 168; // px/s

// Collision footprint multiplier for haul trucks. Their real body is ~1.45 cells
// long, which under the cell-reservation rule (any cell the body's AABB clips is
// reserved) makes a horizontal truck occupy 3 cells and forces ~3-cell following
// gaps. Shrinking the *collision* footprint (not the sprite) to its centre cell
// lets trucks tuck right up behind one another; the tiny sprite overlap when
// bumper-to-bumper is the accepted trade-off for a tighter convoy.
const TRUCK_COLLISION_SCALE = 0.66;

const SPECS = {
  pickup:    { model: 'Light Utility Vehicle' },
  excavator: { model: 'Liebherr R9400', bucket: 40 },
  oht:       { model: 'Liebherr T264', payload: 240 },
  dozer:     { model: 'Liebherr PR776' },
};

// Excavator reference models. `scale` multiplies the base visual size.
const EXCAVATORS = {
  R9400: { model: 'Liebherr R9400', bucket: 40, scale: 1.0 },
  R9600: { model: 'Liebherr R9600', bucket: 60, scale: 1.275 },
  R9800: { model: 'Liebherr R9800', bucket: 75, scale: 1.275 * 1.5 }, // 1.5× the R9600
};

// Minimum Chebyshev block distance between two shovels when spawning a new one
// (3 ⇒ at least two empty blocks between them, so shovels never spawn stacked).
const SHOVEL_MIN_BLOCK_DIST = 3;

// Extra crushers the player can buy and place, beyond the ones generated at start.
const CRUSHER_PRICE = 1000000;
const MAX_EXTRA_CRUSHERS = 5;

// Buyable assets (shop). Prices in $.
const MAX_ASSETS = 150;
const CATALOG = [
  { id: 'LV',    type: 'pickup',    model: 'Light Utility Vehicle', price: 25000,  spec: 'Manual scout vehicle' },
  { id: 'T264',  type: 'oht',       model: 'Liebherr T264',         price: 100000, spec: 'Haul truck — 240 t payload' },
  { id: 'R9400', type: 'excavator', model: 'Liebherr R9400',        price: 400000, spec: 'Shovel — 40 t bucket' },
  { id: 'R9600', type: 'excavator', model: 'Liebherr R9600',        price: 600000, spec: 'Shovel — 60 t bucket' },
  { id: 'R9800', type: 'excavator', model: 'Liebherr R9800',        price: 800000, spec: 'Shovel — 75 t bucket' },
  { id: 'PR776', type: 'dozer',     model: 'Liebherr PR776',        price: 500000, spec: 'Track dozer — blade & ripper' },
];

// ── Autopilot tuning ──
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BUCKET_TIME = 1.5;          // s per bucket pass
const TRUCK_CAP = 240;            // truck payload (t)
const DUMP_TIME = 5;              // s to dump at the crusher
const PARK_RECHECK = 0.4;

// Anti-jam timers (in ticks). When a truck cannot make forward progress because
// another vehicle blocks the shortest step, it waits a few ticks, then is allowed
// to take a longer sideways detour, and finally (deadlock) to reverse one cell to
// yield. Thresholds keep this from degenerating into back-and-forth jitter.
const STUCK_DETOUR = 5;           // ticks a truck waits for a blocked shortest step before detouring
const STUCK_DODGE = 24;           // …and after this, if still boxed in by a vehicle, dodge off-road
const DIST_CACHE_MAX = 64;        // cap distinct cached distance fields

// "gx,gy" key for the sub-zone grid (used for road cells, occupancy, distance fields).
const key = (gx, gy) => `${gx},${gy}`;

// Do two sub-zone rectangles { x, y, w, h } overlap?
const rectsOverlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

module.exports = {
  VIEW_W, VIEW_H, COLS, ROWS, BLOCKS_PER_CRUSHER,
  STARTING_CREDIT, DRILL_COST, DOZER_PREP_RANGE,
  ORE_VALUE, PARKING, PARK_HEADING, PARK_BLOCKS,
  BASE_SPEED, TRUCK_COLLISION_SCALE, SPECS, EXCAVATORS,
  SHOVEL_MIN_BLOCK_DIST, CRUSHER_PRICE, MAX_EXTRA_CRUSHERS, MAX_ASSETS, CATALOG,
  DIRS, BUCKET_TIME, TRUCK_CAP, DUMP_TIME, PARK_RECHECK,
  STUCK_DETOUR, STUCK_DODGE, DIST_CACHE_MAX,
  key, rectsOverlap,
};
