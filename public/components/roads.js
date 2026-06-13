// One-way road editor, drawn on the sub-zone grid (a road is exactly one
// sub-zone — a quarter of a block — wide). Drag in road mode to lay a directed
// path; the flow follows the stroke. Roads can loop and form T / X
// intersections (adjacent cells merge automatically). The "invert" action flips
// the circulation direction of the whole network.

import { applyCamera, toWorld } from './camera.js';

export class Roads {
  constructor(canvas, view, grid) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.grid = grid;
    this.dpr = window.devicePixelRatio || 1;
    this.cells = new Map();      // "gx,gy" -> { gx, gy, dir:{dx,dy}|null, parking }
    this.parkings = [];          // { x, y, w, h } patches (rendered distinctly)
    this.crusher = null;         // { x, y, w, h } sub-zone footprint (not a road)
    this.tool = 'none';          // 'none' | 'draw' | 'erase'
    this.editing = false;        // draw or erase active → denser/highlighted arrows
    this.drawing = false;
    this.last = null;

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', () => { this.drawing = false; });
  }

  resize(cssW, cssH) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.render();
  }

  setTool(tool) {
    this.tool = tool;
    this.editing = tool !== 'none';
    this.canvas.style.pointerEvents = tool === 'none' ? 'none' : 'auto';
    this.canvas.style.cursor = tool === 'erase' ? 'cell' : tool === 'draw' ? 'crosshair' : 'default';
    this.render(); // toggle between editing (denser) and reduced arrows
  }

  invert() {
    for (const c of this.cells.values()) {
      if (c.dir) c.dir = { dx: -c.dir.dx, dy: -c.dir.dy };
    }
    this.render();
  }

  clear() {
    this.cells.clear();
    this.render();
  }

  isRoad(gx, gy) {
    return this.cells.has(this.key(gx, gy));
  }

  // A drivable parking pad — its cells count as road so OHTs can sit and leave.
  addParking(x, y, w, h) {
    this.parkings.push({ x, y, w, h });
    for (let gy = y; gy < y + h; gy++) {
      for (let gx = x; gx < x + w; gx++) this._ensure(gx, gy).parking = true;
    }
    this.render();
  }

  // Crusher building (sub-zone footprint). Not a road: trucks dump from an
  // adjacent road cell.
  setCrusher(x, y, w, h) {
    this.crusher = { x, y, w, h };
    this.render();
  }

  // ── drawing ──
  key(gx, gy) { return `${gx},${gy}`; }

  _ensure(gx, gy) {
    const k = this.key(gx, gy);
    if (!this.cells.has(k)) this.cells.set(k, { gx, gy, dir: null });
    return this.cells.get(k);
  }

  _cellAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const w = toWorld(e.clientX, e.clientY, rect);
    const gx = Math.floor(w.x / this.grid.zoneW);
    const gy = Math.floor(w.y / this.grid.zoneH);
    return {
      gx: Math.max(0, Math.min(this.grid.zoneCols - 1, gx)),
      gy: Math.max(0, Math.min(this.grid.zoneRows - 1, gy)),
    };
  }

  _down(e) {
    if (this.tool === 'none') return;
    this.drawing = true;
    this.last = this._cellAt(e);
    if (this.tool === 'draw') this._ensure(this.last.gx, this.last.gy);
    else this._eraseAt(this.last.gx, this.last.gy);
    this.render();
  }

  _move(e) {
    if (this.tool === 'none' || !this.drawing) return;
    const cur = this._cellAt(e);
    if (this.tool === 'draw') this._connectTo(cur);
    else this._eraseLine(cur);
    this.render();
  }

  _eraseAt(gx, gy) {
    const c = this.cells.get(this.key(gx, gy));
    if (c && !c.parking) this.cells.delete(this.key(gx, gy)); // keep parking pads
  }

  // Erase every cell between `last` and `cur` (fills gaps from fast drags).
  _eraseLine(cur) {
    let { gx, gy } = this.last;
    let guard = 0;
    while ((gx !== cur.gx || gy !== cur.gy) && guard++ < 1000) {
      const ddx = cur.gx - gx;
      const ddy = cur.gy - gy;
      let dx = 0;
      let dy = 0;
      if (Math.abs(ddx) >= Math.abs(ddy)) dx = Math.sign(ddx);
      else dy = Math.sign(ddy);
      if (dx === 0 && dy === 0) break;
      gx += dx;
      gy += dy;
      this._eraseAt(gx, gy);
    }
    this.last = { gx, gy };
  }

  // Walk orthogonally from `last` to `cur`, setting each cell's outgoing flow
  // toward the next one (fills gaps from fast drags).
  _connectTo(cur) {
    let { gx, gy } = this.last;
    let guard = 0;
    while ((gx !== cur.gx || gy !== cur.gy) && guard++ < 1000) {
      const ddx = cur.gx - gx;
      const ddy = cur.gy - gy;
      let dx = 0;
      let dy = 0;
      if (Math.abs(ddx) >= Math.abs(ddy)) dx = Math.sign(ddx);
      else dy = Math.sign(ddy);
      if (dx === 0 && dy === 0) break;

      this._ensure(gx, gy).dir = { dx, dy };
      gx += dx;
      gy += dy;
      this._ensure(gx, gy);
    }
    this.last = { gx, gy };
  }

  // ── rendering ──
  render() {
    const ctx = this.ctx;
    const { zoneW, zoneH } = this.grid;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    applyCamera(ctx, this.dpr);

    // asphalt (slight overlap hides sub-pixel seams between cells)
    ctx.fillStyle = '#3a3e45';
    for (const c of this.cells.values()) {
      if (c.parking) continue;
      ctx.fillRect(c.gx * zoneW, c.gy * zoneH, zoneW + 0.6, zoneH + 0.6);
    }

    // thin white edge lines along the outer sides of the road
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = Math.max(1, Math.min(zoneW, zoneH) * 0.07);
    ctx.beginPath();
    for (const c of this.cells.values()) {
      if (c.parking) continue;
      const x = c.gx * zoneW;
      const y = c.gy * zoneH;
      if (!this.isRoad(c.gx, c.gy - 1)) { ctx.moveTo(x, y); ctx.lineTo(x + zoneW, y); }
      if (!this.isRoad(c.gx, c.gy + 1)) { ctx.moveTo(x, y + zoneH); ctx.lineTo(x + zoneW, y + zoneH); }
      if (!this.isRoad(c.gx - 1, c.gy)) { ctx.moveTo(x, y); ctx.lineTo(x, y + zoneH); }
      if (!this.isRoad(c.gx + 1, c.gy)) { ctx.moveTo(x + zoneW, y); ctx.lineTo(x + zoneW, y + zoneH); }
    }
    ctx.stroke();

    // parking pads
    for (const p of this.parkings) {
      const x = p.x * zoneW;
      const y = p.y * zoneH;
      const w = p.w * zoneW;
      const h = p.h * zoneH;
      ctx.fillStyle = '#474d57';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#f2b81c';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(242, 184, 28, 0.85)';
      ctx.font = `bold ${Math.round(Math.min(w, h) * 0.5)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', x + w / 2, y + h / 2);
    }

    // crusher building
    if (this.crusher) {
      const x = this.crusher.x * zoneW;
      const y = this.crusher.y * zoneH;
      const w = this.crusher.w * zoneW;
      const h = this.crusher.h * zoneH;
      ctx.fillStyle = '#4a4f57';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#2e3137';            // hopper
      ctx.beginPath();
      ctx.moveTo(x + w * 0.18, y + h * 0.12);
      ctx.lineTo(x + w * 0.82, y + h * 0.12);
      ctx.lineTo(x + w * 0.6, y + h * 0.55);
      ctx.lineTo(x + w * 0.4, y + h * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#6b7077';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      ctx.fillStyle = '#e8e8e8';
      ctx.font = `bold ${Math.round(Math.min(w, h) * 0.16)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CRUSHER', x + w / 2, y + h * 0.8);
    }

    // Lane arrows. While editing (road mode) every cell shows a highlighted
    // arrow so the flow is clear; once done only turns / intersections / every
    // ~10 sub-blocks keep one. Arrows curve through turns and intersections.
    const s = Math.min(zoneW, zoneH);
    const period = this.editing ? 4 : 10; // denser while editing, sparse after
    for (const c of this.cells.values()) {
      if (!c.dir || c.parking) continue;
      if (this._arrowHere(c, period)) this._arrow(ctx, c, s, this.editing);
    }
  }

  _arrowHere(c, period) {
    // intersection (T / X): 3+ orthogonal road neighbours
    let nb = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (this.isRoad(c.gx + dx, c.gy + dy)) nb++;
    }
    if (nb >= 3) return true;
    const inc = this._incomingDir(c);
    if (inc && (inc.dx !== c.dir.dx || inc.dy !== c.dir.dy)) return true; // turn
    return ((c.gx + c.gy) % period) === 0; // periodic marker on straights
  }

  // Direction of the road cell flowing INTO this one (for curved turn arrows).
  _incomingDir(c) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = this.cells.get(this.key(c.gx + dx, c.gy + dy));
      if (p && p.dir && p.gx + p.dir.dx === c.gx && p.gy + p.dir.dy === c.gy) return p.dir;
    }
    return null;
  }

  // Painted arrow: straight on straights, curved (left/right) through turns.
  // Fine, crisp line marking with a slim arrowhead.
  _arrow(ctx, c, s, highlight) {
    const cx = (c.gx + 0.5) * this.grid.zoneW;
    const cy = (c.gy + 0.5) * this.grid.zoneH;
    const out = c.dir;
    const inc = this._incomingDir(c);
    const turning = inc && (inc.dx !== out.dx || inc.dy !== out.dy);
    const r = s * 0.4;
    const head = s * 0.17;

    ctx.save();
    ctx.translate(cx, cy);
    const color = highlight ? 'rgba(255, 226, 96, 0.9)' : 'rgba(248, 248, 242, 0.85)';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(0.8, s * (highlight ? 0.075 : 0.06));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const ex = out.dx * r;
    const ey = out.dy * r;
    ctx.beginPath();
    if (turning) {
      ctx.moveTo(-inc.dx * r, -inc.dy * r);
      ctx.quadraticCurveTo(0, 0, ex - out.dx * head * 0.6, ey - out.dy * head * 0.6);
    } else {
      ctx.moveTo(-out.dx * r, -out.dy * r);
      ctx.lineTo(ex - out.dx * head * 0.6, ey - out.dy * head * 0.6);
    }
    ctx.stroke();
    this._head(ctx, ex, ey, out, head);
    ctx.restore();
  }

  _head(ctx, x, y, dir, head) {
    const w = head * 0.72;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(dir.dy, dir.dx));
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-head, -w / 2);
    ctx.lineTo(-head, w / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
