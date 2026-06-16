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
    for (let y = y0; y <= y1; y++) {
      const row = this.mine.blocks[y];
      for (let x = x0; x <= x1; x++) {
        const b = row[x];
        let color;
        if (!b.explored) color = COLORS.unexplored;
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

    // sub-zone guides — one dashed stroke for the whole visible grid
    const guides = new Path2D();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
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
