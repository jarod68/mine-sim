// Renders the mine grid on a 1024×720 canvas and reports block clicks.
// Each block shows the dirt base tinted by its ore (color = type, opacity =
// richness) and is split into 4 sub-zones by dashed guides.

import { COLORS } from './mine.js';
import { applyCamera, toWorld } from './camera.js';

// World coordinate space — must match the server (game/world.js).
export const VIEW_W = 3553;
export const VIEW_H = 2480;

export class GameCanvas {
  constructor(canvas, mine, onBlockClick) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mine = mine;
    this.onBlockClick = onBlockClick;
    this.dpr = window.devicePixelRatio || 1;

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

    for (let y = 0; y < this.mine.rows; y++) {
      for (let x = 0; x < this.mine.cols; x++) {
        this._drawBlock(this.mine.blocks[y][x], x * bw, y * bh);
      }
    }
  }

  // Deterministic faint shade per cell so unexplored ground isn't flat.
  _shade(x, y) {
    const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    return ((h % 100) / 100) * 0.09;
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

  _drawBlock(block, px, py) {
    const ctx = this.ctx;
    const { bw, bh } = this;

    // Translucent fills over the near-black canvas (glass-terminal look).
    if (!block.explored) {
      // undiscovered — dim phosphor void
      ctx.fillStyle = COLORS.unexplored;
      ctx.fillRect(px, py, bw, bh);
    } else if (block.ore && block.oreRemaining > 0) {
      // still holds minable ore — neon ore glow, hatched to mark the deposit
      ctx.fillStyle = COLORS[block.ore];
      ctx.fillRect(px, py, bw, bh);
      this._hatch(px, py, bw, bh);
    } else {
      // mined out (or barren) — faint void, no hatching
      ctx.fillStyle = COLORS.dirt;
      ctx.fillRect(px, py, bw, bh);
    }

    // 4 sub-zones (2×2) — faint phosphor guides
    ctx.strokeStyle = 'rgba(92, 209, 122, 0.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px + bw / 2, py);
    ctx.lineTo(px + bw / 2, py + bh);
    ctx.moveTo(px, py + bh / 2);
    ctx.lineTo(px + bw, py + bh / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // block border — phosphor grid line
    ctx.strokeStyle = 'rgba(92, 209, 122, 0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, bw, bh);
  }
}
