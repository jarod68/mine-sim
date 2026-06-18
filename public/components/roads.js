// One-way road editor, drawn on the sub-zone grid (a road is exactly one
// sub-zone — a quarter of a block — wide). Drag in road mode to lay a directed
// path; the flow follows the stroke. Roads can loop and form T / X
// intersections (adjacent cells merge automatically). The "invert" action flips
// the circulation direction of the whole network.

import { applyCamera, toWorld, camera, DPR } from './camera.js';

export class Roads {
  constructor(canvas, view, grid) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.grid = grid;
    this.dpr = DPR;
    this.cells = new Map();      // "gx,gy" -> { gx, gy, dir:{dx,dy}|null, parking }
    this.parkings = [];          // { x, y, w, h } patches (rendered distinctly)
    this.crushers = [];          // [{ x, y, w, h }] sub-zone footprints (not roads)
    this.tool = 'none';          // 'none' | 'draw' | 'erase'
    this.editing = false;        // draw or erase active → denser/highlighted arrows
    this.drawing = false;
    this.last = null;
    this.onChange = null;        // called after edits (persist to server)
    this.onRender = null;        // set by the host to coalesce redraws into one rAF
    this.onPan = null;           // set by the host to redraw all layers when we auto-pan

    // Edge auto-pan: while drawing toward a screen edge, scroll the view that way.
    this._panVX = 0; this._panVY = 0;
    this._panRAF = null;
    this._lastPointer = null;

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', () => {
      if (this.drawing) { this.drawing = false; this._stopEdgePan(); this._changed(); }
    });
  }

  // A world point inside the (first) parking pad — used to open the resize UI.
  pointInParking(wx, wy) {
    const p = this.parkings[0];
    if (!p) return false;
    const x = p.x * this.grid.zoneW, y = p.y * this.grid.zoneH;
    return wx >= x && wx < x + p.w * this.grid.zoneW && wy >= y && wy < y + p.h * this.grid.zoneH;
  }

  // Replace the (single) parking pad locally with a new sub-zone rect — used for
  // live resize preview before the server confirms. Clears the old pad cells.
  setParking(rect) {
    if (!rect) return;
    for (const [k, c] of [...this.cells]) if (c.parking) this.cells.delete(k);
    this.parkings = [];
    this.addParking(rect.x, rect.y, rect.w, rect.h);
  }

  _changed() { if (this.onChange) this.onChange(); }

  // Request a redraw. The host routes this through a shared rAF so many edits or
  // pan/zoom events in one frame collapse into a single render(); without a host
  // hook we fall back to drawing immediately.
  _invalidate() { if (this.onRender) this.onRender(); else this.render(); }

  // Non-parking road cells, as a plain array (for server persistence).
  serialize() {
    const out = [];
    for (const c of this.cells.values()) {
      if (c.parking) continue;
      out.push({ gx: c.gx, gy: c.gy, dir: c.dir });
    }
    return out;
  }

  // Restore a road network from serialized cells (does not touch parking pads).
  load(cells) {
    if (!Array.isArray(cells)) return;
    for (const c of cells) {
      const cell = this._ensure(c.gx, c.gy);
      cell.dir = c.dir || null;
    }
    this._invalidate();
  }

  // Replace the whole drawn network with the server's canonical copy (keeps
  // parking pads). Does NOT fire onChange — this is an inbound sync, not an edit.
  setNetwork(cells) {
    for (const [k, c] of [...this.cells]) if (!c.parking) this.cells.delete(k);
    this.load(cells || []);
  }

  resize(cssW, cssH) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this._invalidate();
  }

  setTool(tool) {
    this.tool = tool;
    this.editing = tool !== 'none';
    this.canvas.style.pointerEvents = tool === 'none' ? 'none' : 'auto';
    this.canvas.style.cursor = tool === 'erase' ? 'cell' : tool === 'draw' ? 'crosshair' : 'default';
    this._invalidate(); // toggle between editing (denser) and reduced arrows
  }

  invert() {
    for (const c of this.cells.values()) {
      if (c.dir) c.dir = { dx: -c.dir.dx, dy: -c.dir.dy };
    }
    this._invalidate();
    this._changed();
  }

  clear() {
    this.cells.clear();
    this._invalidate();
    this._changed();
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
    this._invalidate();
  }

  // Crusher buildings (sub-zone footprints). Not roads: trucks dump from an
  // adjacent road cell.
  setCrushers(list) {
    this.crushers = Array.isArray(list) ? list : [];
    this._invalidate();
  }

  // ── drawing ──
  key(gx, gy) { return `${gx},${gy}`; }

  _ensure(gx, gy) {
    const k = this.key(gx, gy);
    if (!this.cells.has(k)) this.cells.set(k, { gx, gy, dir: null });
    return this.cells.get(k);
  }

  _cellAt(e) { return this._cellAtClient(e.clientX, e.clientY); }

  _cellAtClient(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const w = toWorld(clientX, clientY, rect);
    const gx = Math.floor(w.x / this.grid.zoneW);
    const gy = Math.floor(w.y / this.grid.zoneH);
    return {
      gx: Math.max(0, Math.min(this.grid.zoneCols - 1, gx)),
      gy: Math.max(0, Math.min(this.grid.zoneRows - 1, gy)),
    };
  }

  // ── edge auto-pan while drawing ──
  // When the pointer nears a screen edge mid-stroke, scroll the view that way and
  // keep extending the stroke into the newly revealed area — so a road can be
  // drawn far past the current viewport without releasing the pointer.
  static EDGE_MARGIN = 56;   // px from the edge where panning kicks in
  static EDGE_MAX = 14;      // max pan speed (px/frame) at the very edge

  _updateEdgePan(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const m = Roads.EDGE_MARGIN;
    const ramp = (d) => (Math.max(0, m - d) / m) * Roads.EDGE_MAX;
    const x = clientX - rect.left, y = clientY - rect.top;
    let vx = 0, vy = 0;
    if (x < m) vx = -ramp(x); else if (x > rect.width - m) vx = ramp(rect.width - x);
    if (y < m) vy = -ramp(y); else if (y > rect.height - m) vy = ramp(rect.height - y);
    this._panVX = vx; this._panVY = vy;
    if ((vx || vy) && !this._panRAF) this._panRAF = requestAnimationFrame(() => this._edgeTick());
  }

  _stopEdgePan() {
    this._panVX = this._panVY = 0;
    if (this._panRAF) { cancelAnimationFrame(this._panRAF); this._panRAF = null; }
  }

  _edgeTick() {
    this._panRAF = null;
    if (!this.drawing || (!this._panVX && !this._panVY) || !this._lastPointer) return;
    // Scroll the world under the (possibly stationary) pointer, then continue the
    // stroke to whatever cell now sits beneath it.
    camera.ox -= this._panVX;
    camera.oy -= this._panVY;
    const cur = this._cellAtClient(this._lastPointer.clientX, this._lastPointer.clientY);
    if (this.tool === 'draw') this._connectTo(cur); else this._eraseLine(cur);
    this._invalidate();
    if (this.onPan) this.onPan();             // redraw the other layers too
    this._panRAF = requestAnimationFrame(() => this._edgeTick());
  }

  _down(e) {
    if (this.tool === 'none') return;
    if (e.button !== 0) return;   // left button only — right button pans the map
    this.drawing = true;
    this.drawAxis = null;         // axis locks in on the first deliberate movement
    this.last = this._cellAt(e);
    if (this.tool === 'draw') this._ensure(this.last.gx, this.last.gy);
    else this._eraseAt(this.last.gx, this.last.gy);
    this._invalidate();
  }

  _move(e) {
    if (this.tool === 'none' || !this.drawing) return;
    this._lastPointer = { clientX: e.clientX, clientY: e.clientY };
    const cur = this._cellAt(e);
    if (this.tool === 'draw') this._connectTo(cur);
    else this._eraseLine(cur);
    this._invalidate();
    this._updateEdgePan(e.clientX, e.clientY);   // auto-scroll if we're near an edge
  }

  _eraseAt(gx, gy) {
    const c = this.cells.get(this.key(gx, gy));
    if (c && !c.parking) this.cells.delete(this.key(gx, gy)); // keep parking pads
  }

  // Minimum perpendicular drift (in cells) before a straight drag is allowed to
  // turn. Higher = more forgiving of a slightly shaky pointer.
  static TURN_THRESHOLD = 2;

  _connectTo(cur) { this._drag(cur, 'draw'); }
  _eraseLine(cur) { this._drag(cur, 'erase'); }

  // Forgiving freehand: lock onto an axis and stay on it. The line only turns
  // when the pointer drifts at least TURN_THRESHOLD cells off the line AND that
  // perpendicular move dominates — a small wobble never creates a turn.
  _drag(cur, mode) {
    const gx0 = this.last.gx;
    const gy0 = this.last.gy;
    const ddx = cur.gx - gx0;
    const ddy = cur.gy - gy0;
    if (ddx === 0 && ddy === 0) return;
    if (!this.drawAxis) this.drawAxis = Math.abs(ddx) >= Math.abs(ddy) ? 'h' : 'v';

    const TH = Roads.TURN_THRESHOLD;
    let target;
    let turnTo = null;
    if (this.drawAxis === 'h') {
      if (Math.abs(ddy) >= TH && Math.abs(ddy) > Math.abs(ddx)) { target = { gx: cur.gx, gy: gy0 }; turnTo = 'v'; }
      else target = { gx: cur.gx, gy: gy0 };          // stay on the row
    } else {
      if (Math.abs(ddx) >= TH && Math.abs(ddx) > Math.abs(ddy)) { target = { gx: gx0, gy: cur.gy }; turnTo = 'h'; }
      else target = { gx: gx0, gy: cur.gy };          // stay on the column
    }

    this._stroke(gx0, gy0, target, mode);
    this.last = { gx: target.gx, gy: target.gy };
    if (turnTo) { this.drawAxis = turnTo; this._drag(cur, mode); } // continue around the corner
  }

  // Lay (or erase) a straight run of cells from (gx,gy) to target t.
  _stroke(gx, gy, t, mode) {
    const dx = Math.sign(t.gx - gx);
    const dy = Math.sign(t.gy - gy);
    if (dx === 0 && dy === 0) return;
    let guard = 0;
    while ((gx !== t.gx || gy !== t.gy) && guard++ < 1000) {
      if (mode === 'draw') this._ensure(gx, gy).dir = { dx, dy };
      gx += dx;
      gy += dy;
      if (mode === 'draw') this._ensure(gx, gy); else this._eraseAt(gx, gy);
    }
    if (mode === 'draw') this._ensure(gx, gy).dir = { dx, dy }; // endpoint keeps a flow
  }

  // Two flow directions are exact opposites (e.g. east vs west).
  _opposite(a, b) { return !!(a && b && a.dx === -b.dx && a.dy === -b.dy); }

  // Two flow directions are identical (two lanes of a one-way carriageway).
  _sameDir(a, b) { return !!(a && b && a.dx === b.dx && a.dy === b.dy); }

  // True when this lane runs alongside a parallel lane — another carriageway lane
  // sharing the same axis, whether flowing the same way (multi-lane one-way) or
  // opposite (divided two-way). Checks the neighbours perpendicular to travel
  // (above/below for a horizontal lane, left/right for a vertical one), so BOTH
  // cells of the pair test positive. Such lanes carry only a sparse, regularly
  // spaced arrow — the lane markings already convey the flow.
  _hasParallelLane(c) {
    if (!c.dir) return false;
    const perp = c.dir.dy === 0 ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
    for (const [dx, dy] of perp) {
      const nb = this.cells.get(this.key(c.gx + dx, c.gy + dy));
      if (nb && !nb.parking && (this._opposite(c.dir, nb.dir) || this._sameDir(c.dir, nb.dir))) return true;
    }
    return false;
  }

  // Paint the double yellow centre line wherever two adjacent lanes flow in
  // opposite directions — the US "no passing" marking on the boundary between
  // opposing traffic. Each shared edge is drawn once: a horizontal lane only
  // checks the cell below it, a vertical lane only the cell to its right, so the
  // partner cell never redraws the same line.
  _drawCenterLines(ctx) {
    const { zoneW, zoneH } = this.grid;
    const s = Math.min(zoneW, zoneH);
    const gap = Math.max(0.6, s * 0.08);     // separation of the two yellow lines
    ctx.strokeStyle = 'rgba(240, 198, 30, 0.92)';
    ctx.lineWidth = Math.max(0.5, s * 0.035);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const c of this.cells.values()) {
      if (c.parking || !c.dir) continue;
      const x = c.gx * zoneW;
      const y = c.gy * zoneH;
      if (c.dir.dy === 0) {                   // horizontal lane → opposing lane below
        const nb = this.cells.get(this.key(c.gx, c.gy + 1));
        if (nb && !nb.parking && this._opposite(c.dir, nb.dir)) {
          const ey = (c.gy + 1) * zoneH;
          ctx.moveTo(x, ey - gap / 2); ctx.lineTo(x + zoneW, ey - gap / 2);
          ctx.moveTo(x, ey + gap / 2); ctx.lineTo(x + zoneW, ey + gap / 2);
        }
      } else if (c.dir.dx === 0) {            // vertical lane → opposing lane to the right
        const nb = this.cells.get(this.key(c.gx + 1, c.gy));
        if (nb && !nb.parking && this._opposite(c.dir, nb.dir)) {
          const ex = (c.gx + 1) * zoneW;
          ctx.moveTo(ex - gap / 2, y); ctx.lineTo(ex - gap / 2, y + zoneH);
          ctx.moveTo(ex + gap / 2, y); ctx.lineTo(ex + gap / 2, y + zoneH);
        }
      }
    }
    ctx.stroke();
  }

  // Paint a dashed white lane line wherever two adjacent lanes flow the SAME way
  // (a multi-lane one-way carriageway) — the broken white marking of a highway
  // that vehicles may cross to overtake. One stroke per shared edge.
  _drawLaneLines(ctx) {
    const { zoneW, zoneH } = this.grid;
    const s = Math.min(zoneW, zoneH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = Math.max(0.5, s * 0.035);
    ctx.setLineDash([Math.max(1.5, s * 0.42), Math.max(1.5, s * 0.34)]);
    ctx.beginPath();
    for (const c of this.cells.values()) {
      if (c.parking || !c.dir) continue;
      const x = c.gx * zoneW;
      const y = c.gy * zoneH;
      if (c.dir.dy === 0) {                   // horizontal lane → same-way lane below
        const nb = this.cells.get(this.key(c.gx, c.gy + 1));
        if (nb && !nb.parking && this._sameDir(c.dir, nb.dir)) {
          const ey = (c.gy + 1) * zoneH;
          ctx.moveTo(x, ey); ctx.lineTo(x + zoneW, ey);
        }
      } else if (c.dir.dx === 0) {            // vertical lane → same-way lane to the right
        const nb = this.cells.get(this.key(c.gx + 1, c.gy));
        if (nb && !nb.parking && this._sameDir(c.dir, nb.dir)) {
          const ex = (c.gx + 1) * zoneW;
          ctx.moveTo(ex, y); ctx.lineTo(ex, y + zoneH);
        }
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── rendering ──
  render() {
    const ctx = this.ctx;
    const { zoneW, zoneH } = this.grid;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    applyCamera(ctx, this.dpr);

    // packed-earth "terre battue" surface (slight overlap hides sub-pixel seams)
    ctx.fillStyle = '#a85d34';
    for (const c of this.cells.values()) {
      if (c.parking) continue;
      ctx.fillRect(c.gx * zoneW, c.gy * zoneH, zoneW + 0.6, zoneH + 0.6);
    }

    // edge lines along the outer sides of the road; yellow & dashed while
    // editing, thin white otherwise.
    const s0 = Math.min(zoneW, zoneH);
    ctx.strokeStyle = this.editing ? 'rgba(242, 184, 28, 0.95)' : 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = Math.max(1, s0 * 0.07);
    ctx.setLineDash(this.editing ? [s0 * 0.28, s0 * 0.22] : []);
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
    ctx.setLineDash([]);

    // double yellow centre line between opposing lanes, dashed white line between
    // same-way lanes (US-style highway markings on the shared edges).
    this._drawCenterLines(ctx);
    this._drawLaneLines(ctx);

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

    // crusher buildings
    for (const cr of this.crushers) {
      const x = cr.x * zoneW;
      const y = cr.y * zoneH;
      const w = cr.w * zoneW;
      const h = cr.h * zoneH;
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
    const widePeriod = this.editing ? 12 : 24; // multi-lane roads: one arrow, far apart
    for (const c of this.cells.values()) {
      if (c.parking) continue;
      // A multi-lane carriageway (a lane paired with a parallel one, same way or
      // opposing) shows its flow via the lane markings — keep just a sparse arrow,
      // far apart, like the periodic markings on a real highway lane.
      if (this._hasParallelLane(c)) {
        if (c.dir && ((c.gx + c.gy) % widePeriod) === 0) this._arrow(ctx, c, s, this.editing);
        continue;
      }
      if (this._isJunction(c)) {
        // intersection: one arrow per supported exit direction (flow-respecting)
        for (const e of this._exits(c)) this._arrowDir(ctx, c, s, e, this.editing);
      } else if (c.dir && this._arrowHere(c, period)) {
        this._arrow(ctx, c, s, this.editing);
      }
    }
  }

  // 3+ orthogonal road neighbours → a T or X intersection.
  _isJunction(c) {
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (this.isRoad(c.gx + dx, c.gy + dy)) n++;
    }
    return n >= 3;
  }

  // Directions you may LEAVE this cell toward: a road neighbour you don't enter
  // against its flow (same rule the server pathfinder uses). Shows every move
  // the intersection actually supports.
  _exits(c) {
    const out = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.gx + dx;
      const ny = c.gy + dy;
      if (!this.isRoad(nx, ny)) continue;
      const nc = this.cells.get(this.key(nx, ny));
      const nDir = (nc && !nc.parking) ? nc.dir : null;
      if (nDir && dx === -nDir.dx && dy === -nDir.dy) continue; // can't enter against flow
      out.push([dx, dy]);
    }
    return out;
  }

  _arrowHere(c, period) {
    const inc = this._incomingDir(c);
    if (inc && (inc.dx !== c.dir.dx || inc.dy !== c.dir.dy)) return true; // turn
    return ((c.gx + c.gy) % period) === 0; // periodic marker on straights
  }

  // A short straight arrow from the cell centre toward `dir` — used to mark each
  // supported direction at an intersection.
  _arrowDir(ctx, c, s, dir, highlight) {
    const cx = (c.gx + 0.5) * this.grid.zoneW;
    const cy = (c.gy + 0.5) * this.grid.zoneH;
    const r = s * 0.42;
    const head = s * 0.16;
    const start = s * 0.1;          // begin a little out so arrows don't all collide at the hub
    ctx.save();
    ctx.translate(cx, cy);
    const color = highlight ? 'rgba(255, 226, 96, 0.95)' : 'rgba(120, 220, 255, 0.9)';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(0.8, s * (highlight ? 0.075 : 0.06));
    ctx.lineCap = 'round';
    const ex = dir[0] * r;
    const ey = dir[1] * r;
    ctx.beginPath();
    ctx.moveTo(dir[0] * start, dir[1] * start);
    ctx.lineTo(ex - dir[0] * head * 0.6, ey - dir[1] * head * 0.6);
    ctx.stroke();
    this._head(ctx, ex, ey, { dx: dir[0], dy: dir[1] }, head);
    ctx.restore();
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
