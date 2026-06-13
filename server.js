const express = require('express');
const path = require('path');
const { generateMine, BLOCK_TONNAGE } = require('./game/mine');

const app = express();
const PORT = process.env.PORT || 3200;

// 49 × 36 = 1764 blocks across the view.
const COLS = 49;
const ROWS = 36;

const STARTING_CREDIT = 100000; // $100K
const DRILL_COST = 5000;        // $5K per drill

// Crusher payout per tonne. Iron is the baseline: a full 240 t load = $10K.
// Others are proportionally more (gold, copper) or less (carbon).
const ORE_VALUE = {
  iron:   10000 / 240,
  copper: 16000 / 240,
  gold:   60000 / 240,
  carbon:  6000 / 240,
};

// Parking pad (sub-zone coordinates) and a crusher placed ~15 blocks away. The
// crusher is computed on the server so it stays fixed across page refreshes.
const PARKING = { x: 3, y: 2, w: 6, h: 3 };

// Parking footprint in BLOCK coordinates.
const PARK_BLOCKS = {
  bx0: Math.floor(PARKING.x / 2),
  by0: Math.floor(PARKING.y / 2),
  bx1: Math.floor((PARKING.x + PARKING.w - 1) / 2),
  by1: Math.floor((PARKING.y + PARKING.h - 1) / 2),
};

function blockDistToParking(bx, by) {
  const dx = Math.max(PARK_BLOCKS.bx0 - bx, 0, bx - PARK_BLOCKS.bx1);
  const dy = Math.max(PARK_BLOCKS.by0 - by, 0, by - PARK_BLOCKS.by1);
  return Math.max(dx, dy);
}

// Crusher: 1-block footprint, never on the parking, 2..15 blocks away from it.
function placeCrusher() {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pcx = (PARK_BLOCKS.bx0 + PARK_BLOCKS.bx1) / 2;
  const pcy = (PARK_BLOCKS.by0 + PARK_BLOCKS.by1) / 2;
  for (let i = 0; i < 800; i++) {
    const dist = 2 + Math.random() * 13; // 2 .. 15 blocks
    const ang = Math.random() * Math.PI * 2;
    const cbx = clamp(Math.round(pcx + Math.cos(ang) * dist), 0, COLS - 1);
    const cby = clamp(Math.round(pcy + Math.sin(ang) * dist), 0, ROWS - 1);
    const d = blockDistToParking(cbx, cby);
    if (d >= 2 && d <= 15) return { x: cbx * 2, y: cby * 2, w: 2, h: 2 };
  }
  // fallback: opposite corner, still within range after clamping
  const fbx = clamp(Math.round(pcx) + 8, 0, COLS - 1);
  const fby = clamp(Math.round(pcy) + 8, 0, ROWS - 1);
  return { x: fbx * 2, y: fby * 2, w: 2, h: 2 };
}

let mine = generateMine(COLS, ROWS);
let credit = STARTING_CREDIT;
let crusher = placeCrusher();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Unexplored blocks expose only their position — the composition stays secret
// on the server until the block is drilled.
function publicBlock(b) {
  return b.explored ? b : { x: b.x, y: b.y, explored: false };
}

function publicState() {
  return {
    cols: mine.cols,
    rows: mine.rows,
    blockTonnage: BLOCK_TONNAGE,
    credit,
    drillCost: DRILL_COST,
    parking: PARKING,
    crusher,
    blocks: mine.blocks.map((row) => row.map(publicBlock)),
  };
}

app.get('/api/state', (_req, res) => {
  res.json(publicState());
});

app.post('/api/drill', (req, res) => {
  const { x, y } = req.body || {};
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= mine.cols || y < 0 || y >= mine.rows) {
    return res.status(400).json({ error: 'invalid coordinates', credit });
  }
  const block = mine.blocks[y][x];
  // Already drilled → no charge, just return it.
  if (block.explored) return res.json({ block, credit });
  if (credit < DRILL_COST) {
    return res.status(402).json({ error: 'insufficient credit', credit });
  }
  credit -= DRILL_COST;
  block.explored = true;
  res.json({ block, credit });
});

// Extract ore from an explored block (the shovel digging). Authoritative:
// clamps to what's left and returns the actually mined amount.
app.post('/api/mine', (req, res) => {
  const { x, y, amount } = req.body || {};
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || x >= mine.cols || y < 0 || y >= mine.rows) {
    return res.status(400).json({ error: 'invalid coordinates' });
  }
  const block = mine.blocks[y][x];
  if (!block.explored) return res.status(400).json({ error: 'block not explored' });

  const want = Math.max(0, Math.floor(Number(amount) || 0));
  const mined = Math.min(want, block.oreRemaining);
  block.oreRemaining -= mined;
  res.json({ block, mined });
});

// A truck dumping its load at the crusher gets paid for the ore delivered.
app.post('/api/deliver', (req, res) => {
  const { ore, tons } = req.body || {};
  const t = Math.max(0, Math.floor(Number(tons) || 0));
  const rate = ORE_VALUE[ore] || 0;
  const pay = Math.round(rate * t);
  credit += pay;
  res.json({ credit, pay });
});

app.post('/api/reset', (_req, res) => {
  mine = generateMine(COLS, ROWS);
  credit = STARTING_CREDIT;
  crusher = placeCrusher();
  res.json(publicState());
});

app.listen(PORT, () => {
  console.log(`mine-sim running on http://localhost:${PORT}`);
});
