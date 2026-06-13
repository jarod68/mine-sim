// Renders the mine grid on a 1024×720 canvas and reports block clicks.
// Each block shows the dirt base tinted by its ore (color = type, opacity =
// richness) and is split into 4 sub-zones by dashed guides.

import { COLORS } from './mine.js';
import { applyCamera, toWorld } from './camera.js';

export const VIEW_W = 2048;
export const VIEW_H = 1440;

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

  _drawBlock(block, px, py) {
    const ctx = this.ctx;
    const { bw, bh } = this;

    if (!block.explored) {
      // hidden until drilled — neutral colour + a faint "?"
      ctx.fillStyle = COLORS.unexplored;
      ctx.fillRect(px, py, bw, bh);
      ctx.fillStyle = `rgba(0, 0, 0, ${this._shade(block.x, block.y)})`;
      ctx.fillRect(px, py, bw, bh);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.font = `${Math.round(Math.min(bw, bh) * 0.5)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', px + bw / 2, py + bh / 2);
    } else {
      // dirt base
      ctx.fillStyle = COLORS.dirt;
      ctx.fillRect(px, py, bw, bh);
      // ore tint (color = type, opacity = remaining richness; fades as mined)
      if (block.ore && block.oreRemaining > 0) {
        const frac = block.oreRemaining / block.tonnage; // 0 .. ~0.6
        ctx.globalAlpha = 0.18 + 0.72 * Math.min(1, frac / 0.6);
        ctx.fillStyle = COLORS[block.ore];
        ctx.fillRect(px, py, bw, bh);
        ctx.globalAlpha = 1;
      }
    }

    // 4 sub-zones (2×2) — dashed guides
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px + bw / 2, py);
    ctx.lineTo(px + bw / 2, py + bh);
    ctx.moveTo(px, py + bh / 2);
    ctx.lineTo(px + bw, py + bh / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // block border
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, bw, bh);
  }
}
