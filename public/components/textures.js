// Blocky 16×16 pixel textures, generated procedurally (no image assets) and
// cached: grass for unexplored ground, dirt, stone flecked with ore, deepslate
// for unprepared rich veins, and the surfaces roads / pads / crushers use.
// Every texture is deterministic, so a block always looks the same.

export const TEX = 16;   // texels per side

// Shared pixel font for canvas labels (self-hosted, see style.css @font-face).
export const PIXEL_FONT = '"Pixelify Sans", system-ui, sans-serif';

// Small deterministic PRNG (mulberry32) — one stream per texture.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASES = {
  grass:     { seed: 11, pal: ['#56693a', '#5f7340', '#4c5e33', '#677a47', '#516437'] },   // muted moss
  dirt:      { seed: 23, pal: ['#866043', '#79553a', '#96704e', '#6b4a30', '#8c6748'] },
  stone:     { seed: 37, pal: ['#7f7f7f', '#8b8b8b', '#747474', '#6c6c6c', '#959595'] },
  deepslate: { seed: 41, pal: ['#4b4b52', '#56565e', '#3f3f46', '#5f5f68', '#45454c'] },
  path:      { seed: 53, pal: ['#9b7b45', '#a8884f', '#8e6f3d', '#b39459', '#947440'] },
  gravel:    { seed: 59, pal: ['#6f5a3a', '#5e4b30', '#7d6744', '#544329', '#836c47'] },
  cobble:    { seed: 61, pal: ['#6e6e6e', '#7c7c7c', '#5d5d5d', '#8a8a8a', '#4f4f4f'] },
};

// Ore flecks over stone: light / mid / dark shades of each ore.
const ORES = {
  iron:   ['#e8c7aa', '#d8af93', '#a87e62'],
  copper: ['#f08d4f', '#c9662f', '#5aa88f'],   // last = verdigris
  gold:   ['#fff8a0', '#fcee4b', '#d9a521'],
  carbon: ['#3a3a3a', '#232323', '#111111'],
};

// Fixed vein clusters (texel offsets), shared by every ore so they read as one family.
const CLUSTERS = [
  [[2, 2], [3, 2], [2, 3], [3, 3], [4, 3]],
  [[10, 3], [11, 3], [11, 4], [12, 4], [10, 4]],
  [[4, 10], [5, 10], [5, 11], [6, 11], [4, 11], [5, 12]],
  [[11, 11], [12, 11], [12, 12], [13, 12], [11, 12]],
  [[8, 7], [8, 8], [7, 8]],
];

const cache = new Map();

function noise(ctx, { seed, pal }) {
  const r = prng(seed);
  for (let y = 0; y < TEX; y++)
    for (let x = 0; x < TEX; x++) {
      ctx.fillStyle = pal[Math.floor(r() * pal.length)];
      ctx.fillRect(x, y, 1, 1);
    }
}

// Darker texel outline just inside the edge — the "block" seam.
function bevel(ctx, alpha) {
  ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
  ctx.fillRect(0, TEX - 1, TEX, 1);
  ctx.fillRect(TEX - 1, 0, 1, TEX);
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.6})`;
  ctx.fillRect(0, 0, TEX, 1);
  ctx.fillRect(0, 0, 1, TEX);
}

function bricks(ctx) {
  noise(ctx, BASES.stone);
  ctx.fillStyle = '#4e4e4e';                       // mortar
  for (let y = 0; y < TEX; y += 4) ctx.fillRect(0, y + 3, TEX, 1);
  for (let row = 0; row < 4; row++) {
    const off = row % 2 ? 4 : 0;
    for (let x = off; x < TEX; x += 8) ctx.fillRect(x, row * 4, 1, 3);
  }
}

function draw(kind, ctx) {
  if (BASES[kind]) {
    noise(ctx, BASES[kind]);
    if (kind === 'grass' || kind === 'dirt' || kind === 'deepslate') bevel(ctx, 0.12);
    return;
  }
  if (kind === 'bricks') { bricks(ctx); return; }
  const ore = ORES[kind];
  if (!ore) throw new Error(`unknown texture: ${kind}`);
  noise(ctx, BASES.stone);
  const r = prng(BASES.stone.seed + kind.length * 97);
  for (const cl of CLUSTERS)
    for (const [x, y] of cl) {
      ctx.fillStyle = ore[Math.floor(r() * 2)];      // light / mid body
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = ore[2];                        // dark lower-right edge
      ctx.fillRect(x + 1, y + 1, 1, 1);
    }
  bevel(ctx, 0.1);
}

// The 16×16 canvas for `kind` (grass, dirt, stone, deepslate, path, gravel,
// cobble, bricks, or an ore: iron, copper, gold, carbon).
export function texture(kind) {
  let c = cache.get(kind);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = TEX;
    const g = c.getContext('2d');
    if (g) draw(kind, g);              // no 2D context (e.g. a DOM-less test env): blank tile
    cache.set(kind, c);
  }
  return c;
}

// A fill pattern drawing one texture per `cellW × cellH` world cell (aligned
// to the world origin, so it lines up with the block grid).
export function cellPattern(ctx, kind, cellW, cellH) {
  const p = ctx.createPattern(texture(kind), 'repeat');
  p.setTransform(new DOMMatrix().scale(cellW / TEX, cellH / TEX));
  return p;
}

const urls = new Map();
// data: URL of a texture, for CSS swatches (legend, popup, stats).
export function textureURL(kind) {
  if (!urls.has(kind)) urls.set(kind, texture(kind).toDataURL());
  return urls.get(kind);
}

// Mine-grid material → texture kind.
export const BLOCK_TEXTURE = {
  unexplored: 'grass', dirt: 'dirt', prep: 'deepslate',
  iron: 'iron', copper: 'copper', gold: 'gold', carbon: 'carbon',
};

// "Breaking" cracks for a rich vein being prepared: texels revealed in order
// from the centre outward as a branching random walk, so `progress` 0..1 shows
// a growing crack pattern (deterministic, same on every block).
export const CRACK_TEXELS = (() => {
  const r = prng(77);
  const seen = new Set();
  const out = [];
  const walkers = [[7, 7], [8, 8], [8, 7]];
  while (out.length < 70 && walkers.length) {
    const i = Math.floor(r() * walkers.length);
    const [x, y] = walkers[i];
    const k = `${x},${y}`;
    if (!seen.has(k)) { seen.add(k); out.push([x, y]); }
    const d = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]][Math.floor(r() * 8)];
    const nx = x + d[0], ny = y + d[1];
    if (nx < 1 || ny < 1 || nx > TEX - 2 || ny > TEX - 2) { walkers.splice(i, 1); continue; }
    walkers[i] = [nx, ny];
    if (r() < 0.08 && walkers.length < 6) walkers.push([nx, ny]);   // branch
  }
  return out;
})();
