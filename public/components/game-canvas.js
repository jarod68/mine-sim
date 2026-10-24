// Renders the mine grid on a 1024×720 canvas and reports block clicks.
// Each block is drawn with a blocky 16×16 pixel texture (grass = unexplored,
// dirt, stone flecked with ore, deepslate = unprepared rich vein) and is split
// into 4 sub-zones by faint guides. Zoomed far out, flat colours stand in.

import { COLORS } from './mine.js';
import { BLOCK_TEXTURE, CRACK_TEXELS, TEX, cellPattern } from './textures.js';
import { applyCamera, toWorld, visibleRect, camera, DPR } from './camera.js';

// Below this on-screen block size (CSS px) textures, sub-zone guides and borders
// are sub-pixel noise — skip them and draw flat colour fills only.
const DETAIL_PX = 9;

// World coordinate space comes from the server (state.view) — never hard-coded
// here, so client and server can't drift.

export class GameCanvas {
  constructor(canvas, mine, onBlockClick) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mine = mine;
    this.onBlockClick = onBlockClick;
    this.dpr = DPR;

    this.bw = mine.view.w / mine.cols;
    this.bh = mine.view.h / mine.rows;

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
    this.bw = mine.view.w / mine.cols;
    this.bh = mine.view.h / mine.rows;
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
    ctx.imageSmoothingEnabled = false;   // crisp texels

    // ── viewport culling: only touch the blocks actually on screen ──
    const cssW = this.cssW ?? this.canvas.width / this.dpr;
    const cssH = this.cssH ?? this.canvas.height / this.dpr;
    const vr = visibleRect(cssW, cssH);
    const x0 = Math.max(0, Math.floor(vr.x0 / bw));
    const y0 = Math.max(0, Math.floor(vr.y0 / bh));
    const x1 = Math.min(this.mine.cols - 1, Math.floor(vr.x1 / bw));
    const y1 = Math.min(this.mine.rows - 1, Math.floor(vr.y1 / bh));
    if (x1 < x0 || y1 < y0) return;

    // ── level of detail: textures when blocks are big enough on screen ──
    const detailed = bw * camera.scale >= DETAIL_PX;

    // ── base fills, batched by material (one fill() per distinct material) ──
    const byKind = new Map();    // material → Path2D
    const prepCells = [];        // unprepared rich-vein blocks: x, y, passes, max
    for (let y = y0; y <= y1; y++) {
      const row = this.mine.blocks[y];
      for (let x = x0; x <= x1; x++) {
        const b = row[x];
        let kind;
        if (!b.explored) {
          if (b.prep) { kind = 'prep'; prepCells.push(x, y, b.prepPasses || 0, b.prepMax || 10); }
          else kind = 'unexplored';
        }
        else if (b.ore && b.oreRemaining > 0) kind = b.ore;
        else kind = 'dirt';
        let path = byKind.get(kind);
        if (!path) byKind.set(kind, (path = new Path2D()));
        path.rect(x * bw, y * bh, bw, bh);
      }
    }
    for (const [kind, path] of byKind) {
      ctx.fillStyle = detailed ? cellPattern(ctx, BLOCK_TEXTURE[kind], bw, bh) : COLORS[kind];
      ctx.fill(path);
    }
    if (!detailed) return;

    // rich veins: "breaking" cracks grow as the dozer's preparation passes add up
    for (let i = 0; i < prepCells.length; i += 4) this._cracks(prepCells[i], prepCells[i + 1], prepCells[i + 2], prepCells[i + 3]);

    // sub-zone guides — one dashed stroke for the whole visible grid
    const guides = new Path2D();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x * bw, py = y * bh;
        guides.moveTo(px + bw / 2, py); guides.lineTo(px + bw / 2, py + bh);
        guides.moveTo(px, py + bh / 2); guides.lineTo(px + bw, py + bh / 2);
      }
    }
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.stroke(guides);
    ctx.setLineDash([]);

    // block borders — one solid stroke for the whole visible grid
    const borders = new Path2D();
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) borders.rect(x * bw + 0.5, y * bh + 0.5, bw, bh);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke(borders);
  }

  // Crack overlay on a rich-vein block: the first `passes / max` share of the
  // crack texels, drawn as dark pixels on the block's 16×16 texel grid.
  _cracks(bx, by, passes, max) {
    const n = Math.round(CRACK_TEXELS.length * (max ? Math.min(1, passes / max) : 0));
    if (!n) return;
    const ctx = this.ctx;
    const tw = this.bw / TEX, th = this.bh / TEX;
    const px = bx * this.bw, py = by * this.bh;
    ctx.fillStyle = 'rgba(12, 10, 14, 0.72)';
    for (let i = 0; i < n; i++) {
      const [tx, ty] = CRACK_TEXELS[i];
      ctx.fillRect(px + tx * tw, py + ty * th, tw, th);
    }
  }
}
