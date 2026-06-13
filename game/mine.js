// Server-side mine model + gameplay logic (authoritative).
//
// A mine is a grid of mining blocks. Each block weighs BLOCK_TONNAGE tonnes
// (dirt + at most one ore type, the two percentages summing to 100). Ore is laid
// out in CONTIGUOUS deposits. A block's composition stays hidden until it is
// drilled (`explored`). The client never receives unexplored composition.

const ORE_TYPES = ['iron', 'copper', 'gold', 'carbon'];

const ORE_LABELS = {
  iron:   'Iron',
  copper: 'Copper',
  gold:   'Gold',
  carbon: 'Carbon',
};

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

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

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

function generateMine(cols, rows) {
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

  return mine;
}

module.exports = {
  generateMine,
  BLOCK_TONNAGE,
  ORE_TYPES,
  ORE_LABELS,
};
