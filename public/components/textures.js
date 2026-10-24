// Blocky 16×16 pixel textures, generated procedurally (no image assets) and
// cached, in the palette of an Australian open-pit mine: concrete pads and
// plant, and the pit-floor / sandstone / hi-vis / gold-flecked surfaces the UI
// theme uses. (The mine grid and the roads keep their flat colours — see
// game-canvas.js and roads.js.) Every texture is deterministic.

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
  pit:       { seed: 23, pal: ['#7a3f24', '#6e3820', '#85482a', '#5f2f1b', '#8c4e2f'] },   // pit floor
  rock:      { seed: 37, pal: ['#8a6a5a', '#7d5f50', '#96766a', '#6f5446', '#a08070'] },   // host rock
  concrete:  { seed: 61, pal: ['#9a948a', '#8f897f', '#a59f95', '#857f76', '#aaa49a'] },
  sandstone: { seed: 67, pal: ['#a8743f', '#9c6a38', '#b27c45', '#916234', '#ad7842'] },   // UI buttons
  hivis:     { seed: 71, pal: ['#e8651c', '#f06f22', '#dc5d18', '#f47a2c', '#e36a1f'] },   // UI active
};

// Ore flecks over host rock: light / mid / dark shades of each ore.
const ORES = {
  gold:   ['#ffe08a', '#f2c14e', '#b8862b'],
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

// Concrete pad: 8×8 slabs with darker saw-cut joints.
function slabs(ctx) {
  noise(ctx, BASES.concrete);
  ctx.fillStyle = '#6f6a62';
  for (const o of [7, 15]) { ctx.fillRect(0, o, TEX, 1); ctx.fillRect(o, 0, 1, TEX); }
}

function draw(kind, ctx) {
  if (kind === 'pad') { slabs(ctx); return; }
  if (BASES[kind]) {
    noise(ctx, BASES[kind]);
    if (kind === 'pit') bevel(ctx, 0.12);
    return;
  }
  const ore = ORES[kind];
  if (!ore) throw new Error(`unknown texture: ${kind}`);
  noise(ctx, BASES.rock);
  const r = prng(BASES.rock.seed + kind.length * 97);
  for (const cl of CLUSTERS)
    for (const [x, y] of cl) {
      ctx.fillStyle = ore[Math.floor(r() * 2)];      // light / mid body
      ctx.fillRect(x, y, 1, 1);
      ctx.fillStyle = ore[2];                        // dark lower-right edge
      ctx.fillRect(x + 1, y + 1, 1, 1);
    }
  bevel(ctx, 0.1);
}

// The 16×16 canvas for `kind` (pit, rock, concrete, pad,
// sandstone, hivis, or gold — rock flecked with gold).
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
