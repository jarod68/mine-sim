// Renders the mine grid on a 1024×720 canvas and reports block clicks.
// Each block shows the dirt base tinted by its ore (color = type, opacity =
// richness) and is split into 4 sub-zones by dashed guides.

import { COLORS } from './mine.js';
import { applyCamera, toWorld, visibleRect, camera, DPR } from './camera.js';

// Below this on-screen block size (CSS px) the sub-zone guides, borders and ore
// hatching are sub-pixel noise — skip them and draw flat colour fills only.
const DETAIL_PX = 9;

// World coordinate space — must match the server (game/world.js).
export const VIEW_W = 7942;
export const VIEW_H = 5560;

// Deterministic 2D hash → [0,1). Used to jitter/height the elevation-mesh vertices
// from their GLOBAL grid coordinates so the mesh tiles seamlessly across blocks.
function hash01(a, b) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class GameCanvas {
  constructor(canvas, mine, onBlockClick) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mine = mine;
    this.onBlockClick = onBlockClick;
    this.dpr = DPR;

    this.bw = VIEW_W / mine.cols;
    this.bh = VIEW_H / mine.rows;

    canvas.addEventListener('click', (e) => this._handleClick(e));
  }

  // Size the canvas backing store to the display area (× dpr) and redraw.
  resize(cssW, cssH) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.render();
  }

  setMine(mine) {
    this.mine = mine;
    this.bw = VIEW_W / mine.cols;
    this.bh = VIEW_H / mine.rows;
    this.render();
  }

  _handleClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const w = toWorld(e.clientX, e.clientY, rect);
    const x = Math.floor(w.x / this.bw);
    const y = Math.floor(w.y / this.bh);
    if (x < 0 || x >= this.mine.cols || y < 0 || y >= this.mine.rows) return;
    this.onBlockClick(this.mine.blocks[y][x], { clientX: e.clientX, clientY: e.clientY });
  }

  // Replace a single block with the server's revealed copy and redraw.
  updateBlock(block) {
    this.mine.blocks[block.y][block.x] = block;
    this.render();
  }

  render() {
    const ctx = this.ctx;
    const { bw, bh } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    applyCamera(ctx, this.dpr);

    // ── viewport culling: only touch the blocks actually on screen ──
    const cssW = this.cssW ?? this.canvas.width / this.dpr;
    const cssH = this.cssH ?? this.canvas.height / this.dpr;
    const vr = visibleRect(cssW, cssH);
    const x0 = Math.max(0, Math.floor(vr.x0 / bw));
    const y0 = Math.max(0, Math.floor(vr.y0 / bh));
    const x1 = Math.min(this.mine.cols - 1, Math.floor(vr.x1 / bw));
    const y1 = Math.min(this.mine.rows - 1, Math.floor(vr.y1 / bh));
    if (x1 < x0 || y1 < y0) return;

    // ── base fills, batched by colour (one fill() per distinct colour) ──
    const byColor = new Map();   // colour → Path2D
    const oreCells = [];         // visible ore blocks needing a hatch overlay
    const prepCells = [];        // unprepared rich-vein blocks: x, y, passes, max
    for (let y = y0; y <= y1; y++) {
      const row = this.mine.blocks[y];
      for (let x = x0; x <= x1; x++) {
        const b = row[x];
        let color;
        if (!b.explored) {
          if (b.prep) { color = COLORS.prep; prepCells.push(x, y, b.prepPasses || 0, b.prepMax || 10); }
          else color = COLORS.unexplored;
        }
        else if (b.ore && b.oreRemaining > 0) { color = COLORS[b.ore]; oreCells.push(x, y); }
        else color = COLORS.dirt;
        let path = byColor.get(color);
        if (!path) byColor.set(color, (path = new Path2D()));
        path.rect(x * bw, y * bh, bw, bh);
      }
    }
    for (const [color, path] of byColor) { ctx.fillStyle = color; ctx.fill(path); }

    // ── level of detail: skip the fine grid when blocks are tiny on screen ──
    if (bw * camera.scale < DETAIL_PX) return;

    for (let i = 0; i < oreCells.length; i += 2) this._hatch(oreCells[i] * bw, oreCells[i + 1] * bh, bw, bh);
    // rich-vein elevation mesh replaces the grid here (continuous across blocks)
    for (let i = 0; i < prepCells.length; i += 4) this._prepMesh(prepCells[i], prepCells[i + 1], prepCells[i + 2], prepCells[i + 3]);

    // sub-zone guides — one dashed stroke for the whole visible grid (skip prep cells)
    const guides = new Path2D();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const b = this.mine.blocks[y][x];
        if (b.prep && !b.explored) continue;     // the vein motif stands in for the grid
        const px = x * bw, py = y * bh;
        guides.moveTo(px + bw / 2, py); guides.lineTo(px + bw / 2, py + bh);
        guides.moveTo(px, py + bh / 2); guides.lineTo(px + bw, py + bh / 2);
      }
    }
    ctx.strokeStyle = 'rgba(92, 209, 122, 0.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke(guides);
    ctx.setLineDash([]);

    // block borders — one solid stroke for the whole visible grid
    const borders = new Path2D();
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) borders.rect(x * bw + 0.5, y * bh + 0.5, bw, bh);
    ctx.strokeStyle = 'rgba(92, 209, 122, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke(borders);
  }

  // Rich-vein "elevation mesh": a triangulated grid seen from above, replacing the
  // normal grid lines. Each block holds an N×N sub-grid of vertices whose jitter
  // and height come from a hash of their GLOBAL coordinates, so the mesh is
  // continuous (and seamlessly faceted/shaded) across the whole vein. Block-edge
  // segments are drawn once (skipped when the neighbour is also vein) so no block
  // seam shows. The whole mesh fades as the dozer's preparation passes accumulate.
  _prepMesh(bx, by, passes, max) {
    const ctx = this.ctx;
    const { bw, bh } = this;
    const px = bx * bw, py = by * bh;
    const N = 2;                                   // sub-cells per block → 2·N² triangles
    const prog = max ? Math.min(1, passes / max) : 0;
    const a = 0.9 * (1 - prog) + 0.18;             // fades toward reveal
    const amp = (Math.min(bw, bh) / N) * 0.22;     // organic vertex jitter

    const X = [], Y = [], H = [];                  // vertex grid (N+1)²
    for (let j = 0; j <= N; j++)
      for (let i = 0; i <= N; i++) {
        const gi = bx * N + i, gj = by * N + j;    // global → shared with neighbours
        const k = j * (N + 1) + i;
        // Only INTERIOR vertices jitter — vertices on a block edge stay on the grid
        // so block boundaries read as straight lines (no wavy edges) and still tile.
        const edge = i === 0 || i === N || j === 0 || j === N;
        X[k] = px + (i / N) * bw + (edge ? 0 : (hash01(gi, gj) - 0.5) * 2 * amp);
        Y[k] = py + (j / N) * bh + (edge ? 0 : (hash01(gi + 9173, gj + 1933) - 0.5) * 2 * amp);
        H[k] = hash01(gi + 4421, gj + 7717);       // 0 (low) .. 1 (high)
      }

    const isVein = (x, y) => { const b = this.mine.blocks[y]?.[x]; return !!(b && b.prep && !b.explored); };
    const drawRight = !isVein(bx + 1, by);         // block-edge lines drawn once
    const drawDown = !isVein(bx, by + 1);

    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // shaded facets (brown lightness ∝ average vertex height ⇒ relief)
    const facet = (p, q, r) => {
      const h = (H[p] + H[q] + H[r]) / 3, L = 0.22 + h * 0.55;
      ctx.fillStyle = `rgba(${Math.round(168 * L)}, ${Math.round(112 * L)}, ${Math.round(60 * L)}, ${(a * 0.55).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(X[p], Y[p]); ctx.lineTo(X[q], Y[q]); ctx.lineTo(X[r], Y[r]); ctx.closePath(); ctx.fill();
    };
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const tl = j * (N + 1) + i, tr = tl + 1, bl = tl + (N + 1), br = bl + 1;
        facet(tl, tr, br); facet(tl, br, bl);
      }
    // wireframe (top + left + diagonal per cell; right/bottom only on the outer edge)
    ctx.strokeStyle = `rgba(176, 122, 70, ${(a * 0.9).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.35, Math.min(bw, bh) * 0.024);
    const seg = (p, q) => { ctx.beginPath(); ctx.moveTo(X[p], Y[p]); ctx.lineTo(X[q], Y[q]); ctx.stroke(); };
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const tl = j * (N + 1) + i, tr = tl + 1, bl = tl + (N + 1), br = bl + 1;
        seg(tl, tr); seg(tl, bl); seg(tl, br);     // top, left, diagonal
        if (i === N - 1 && drawRight) seg(tr, br); // block right edge
        if (j === N - 1 && drawDown) seg(bl, br);  // block bottom edge
      }
    ctx.restore();
  }

  // Diagonal hatching clipped to a block — marks a cell that still holds ore.
  _hatch(px, py, bw, bh) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, bw, bh);
    ctx.clip();
    ctx.strokeStyle = 'rgba(225, 255, 240, 0.22)';
    ctx.lineWidth = Math.max(1, Math.min(bw, bh) * 0.05);
    const gap = Math.max(4, Math.min(bw, bh) * 0.24);
    for (let d = -bh; d < bw; d += gap) {
      ctx.beginPath();
      ctx.moveTo(px + d, py);
      ctx.lineTo(px + d + bh, py + bh);
      ctx.stroke();
    }
    ctx.restore();
  }

}
