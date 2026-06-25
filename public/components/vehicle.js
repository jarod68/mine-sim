// Client-side fleet RENDERER. The simulation (movement, collision, autopilot)
// runs entirely on the server; this module only draws the vehicle snapshots it
// receives and forwards manual-driving commands. Positions are smoothed between
// server updates by lerping toward the latest target.

import { applyCamera, visibleRect, DPR } from './camera.js';
import { COLORS_SOLID } from './mine.js';
import { drawPickup, drawDozer, drawGrader, drawExcavator, drawOHT } from './vehicle-sprites.js';

const KEY_DIRS = {
  ArrowUp:    [0, -1],
  ArrowDown:  [0, 1],
  ArrowLeft:  [-1, 0],
  ArrowRight: [1, 0],
};

export class Vehicle {
  constructor(d) {
    this.applyStatic(d);
    this.x = d.x; this.y = d.y;          // rendered position (lerped)
    this.tx = d.x; this.ty = d.y;        // server target
    this.heading = d.heading || 0;
    this.applyDynamic(d);
  }

  applyStatic(d) {
    this.label = d.label;
    this.type = d.type;
    this.model = d.model;
    this.len = d.len;
    this.wid = d.wid;
    this.payload = d.payload;
    this.bucket = d.bucket;
    this.hitR = Math.max(d.len, d.wid) * 0.72;
    this.selR = Math.max(d.len, d.wid) * 0.62;
  }

  applyDynamic(d) {
    this.gx = d.gx; this.gy = d.gy;
    this.load = d.load;
    this.loadOre = d.loadOre;
    this.task = d.task;
    this.digging = d.digging;
    this.manual = d.manual;
    this.shovel = d.shovel;
    this.broken = d.broken ?? false;      // seized up → frozen, smoking
    this.repair = d.repair ?? 0;          // 0..1 repair progress while a LV tends it
    this.prepLine = d.prepLine ?? null;   // dozer sweep line "y,x0,x1,dir" or null
  }

  // Update from a full server snapshot: dynamic state now, position as a target.
  applyServer(d) {
    this.applyDynamic(d);
    this.tx = d.x; this.ty = d.y;
    this.heading = d.heading;            // discrete; set directly (no spin)
  }

  // Merge a partial delta — only the fields actually present are updated.
  applyDelta(d) {
    if ('gx' in d) this.gx = d.gx;
    if ('gy' in d) this.gy = d.gy;
    if ('x' in d) this.tx = d.x;         // position is a lerp target
    if ('y' in d) this.ty = d.y;
    if ('heading' in d) this.heading = d.heading;
    if ('load' in d) this.load = d.load;
    if ('loadOre' in d) this.loadOre = d.loadOre;
    if ('task' in d) this.task = d.task;
    if ('digging' in d) this.digging = d.digging;
    if ('manual' in d) this.manual = d.manual;
    if ('shovel' in d) this.shovel = d.shovel;
    if ('broken' in d) this.broken = d.broken;
    if ('repair' in d) this.repair = d.repair;
    if ('prepLine' in d) this.prepLine = d.prepLine;
  }

  lerp(k) {
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
  }

  draw(ctx, selected) {
    ctx.save();
    ctx.translate(this.x, this.y);

    if (selected) {
      ctx.fillStyle = 'rgba(255, 216, 59, 0.14)';
      ctx.beginPath();
      ctx.arc(0, 0, this.selR + 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffd83b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, this.selR + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    const modelTag = (this.model || '').split(' ').pop();  // e.g. "R9400", "T264"
    ctx.save();
    ctx.rotate(this.heading);
    if (this.type === 'excavator') drawExcavator(ctx, this.len, this.wid, this.digging, modelTag);
    else if (this.type === 'oht') {
      const oreColor = this.loadOre ? COLORS_SOLID[this.loadOre] : null;
      drawOHT(ctx, this.len, this.wid, this.load, oreColor, modelTag);
    } else if (this.type === 'dozer') drawDozer(ctx, this.len, this.wid, modelTag);
    else if (this.type === 'grader') drawGrader(ctx, this.len, this.wid, modelTag);
    else drawPickup(ctx, this.len, this.wid);
    ctx.restore();

    // payload fill % on the dump bed (upright, tracks the heading)
    if (this.type === 'oht' && this.load > 0 && this.payload) {
      const pct = Math.round((this.load / this.payload) * 100);
      const bedX = -this.len * 0.18;
      const bx = bedX * Math.cos(this.heading);
      const by = bedX * Math.sin(this.heading);
      ctx.font = 'bold 5.5px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.strokeText(`${pct}%`, bx, by);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${pct}%`, bx, by);
    }

    // load / dump progress bar (upright, above the vehicle)
    if (this.task) {
      const bw = this.selR * 2;
      const bh = 4;
      const bx = -this.selR;
      const by = -this.selR - 9;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = this.task.kind === 'load' ? '#e0a32a' : '#36c07a';
      ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, this.task.progress)), bh);
    }

    if (this.broken) this._drawBreakdown(ctx);

    // label — kept upright above the vehicle
    ctx.fillStyle = selected ? '#ffd83b' : 'rgba(255, 255, 255, 0.9)';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.label, 0, -this.selR - (this.task ? 15 : 5));

    ctx.restore();
  }

  // Broken-down overlay (upright, in the vehicle's local frame): rising black smoke
  // puffs, and — while a light vehicle is repairing it — a spinning wrench + a green
  // progress ring.
  _drawBreakdown(ctx) {
    const t = performance.now() / 1000;
    const r = this.selR;
    // black smoke: three puffs rising and fading on staggered phases
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.9 + i / 3) % 1;             // 0→1 life of this puff
      const py = -r * 0.5 - ph * (r * 2.2);
      const px = Math.sin((t + i) * 2.2) * r * 0.3;
      const rad = r * (0.32 + ph * 0.5);
      ctx.globalAlpha = (1 - ph) * 0.55;
      ctx.fillStyle = i === 0 ? '#3a3a3a' : '#111111';
      ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (this.repair > 0) {
      // green progress ring under the asset
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#36c07a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, this.repair)); ctx.stroke();
      // spinning wrench glyph
      ctx.save();
      ctx.rotate((t * 4) % (Math.PI * 2));
      ctx.font = `${Math.round(r * 0.9)}px system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🔧', 0, 0);
      ctx.restore();
    } else {
      // warning badge while it waits for help
      ctx.font = `bold ${Math.round(r * 0.8)}px system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚠️', 0, -r - 6);
    }
  }
}

export class Fleet {
  constructor(canvas, view, grid) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.grid = grid;
    this.dpr = DPR;
    this.vehicles = [];
    this.byLabel = new Map();
    this.byId = new Map();        // numeric id → Vehicle (binary position frames)
    this.selected = null;
    this.selectionRect = null;
    this.onControl = null;        // (label, { dir }|{ release }) → POST /api/control
    this.onSelect = null;         // (vehicle|null) → UI hook
    this.debugPaths = {};         // { label: { path:[{gx,gy}], goals:[{gx,gy}] } }
    this.moveMarkers = new Map(); // label → { x, y } destination flag for a move-to order
    this.pressed = new Set();
    this._manualLabel = null;     // label we're currently driving manually
    this._lastKey = null;
    this._payouts = [];           // floating "+$" pops over crushers { x, y, amount, t }

    window.addEventListener('keydown', (e) => {
      if (!KEY_DIRS[e.key]) return;
      this.pressed.add(e.key);
      e.preventDefault();
      this._emit();
    });
    window.addEventListener('keyup', (e) => {
      if (!KEY_DIRS[e.key]) return;
      this.pressed.delete(e.key);
      e.preventDefault();
      this._emit();
    });

    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // Spawn a floating "+$XXX" pop over a crusher (sub-zone centre gx,gy) that just
  // took a load. Rises and fades over ~1.6 s in the animation loop.
  addPayout(gx, gy, amount) {
    const zW = this.grid?.zoneW, zH = this.grid?.zoneH;
    if (!zW) return;
    this._payouts.push({ x: gx * zW, y: gy * zH, amount, t: 0 });
    if (this._payouts.length > 24) this._payouts.shift();   // cap, just in case
  }

  resize(cssW, cssH) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  // Apply a server vehicle snapshot (creates render objects on first sync).
  sync(list) {
    for (const d of list) {
      let v = this.byLabel.get(d.label);
      if (!v) {
        v = new Vehicle(d);
        this.byLabel.set(d.label, v);
        this.vehicles.push(v);
      } else {
        v.applyServer(d);
      }
      v.id = d.id;
      this.byId.set(d.id, v);
    }
    // keep `selected` reference pointing at the live object
    if (this.selected) this.selected = this.byLabel.get(this.selected.label) || null;
  }

  // Merge live deltas (partial NON-positional field updates) by id.
  applyDeltas(list) {
    for (const d of list) {
      const v = this.byId.get(d.id);
      if (v) v.applyDelta(d);            // unknown ids resolve on next full state
    }
  }

  // Apply a binary positions frame (decoded by Net): lerp targets + heading/cell.
  applyPositions(records) {
    for (const r of records) {
      const v = this.byId.get(r.id);
      if (!v) continue;
      v.tx = r.x; v.ty = r.y;
      v.heading = r.heading;
      v.gx = r.gx; v.gy = r.gy;
    }
  }

  // Jump every vehicle straight to its server position (used after a reset).
  snapToTargets() {
    for (const v of this.vehicles) { v.x = v.tx; v.y = v.ty; }
  }

  setSelected(v) {
    if (this.selected === v) return;
    // hand the previously-driven vehicle back to the autopilot
    if (this._manualLabel && (!v || v.label !== this._manualLabel)) {
      this.onControl?.(this._manualLabel, { release: true });
      this._manualLabel = null;
      this._lastKey = null;
    }
    this.selected = v;
    this.onSelect?.(v);
  }

  selectAt(px, py) {
    for (const v of this.vehicles) {
      if (Math.hypot(px - v.x, py - v.y) <= v.hitR) { this.setSelected(v); return v; }
    }
    return null;
  }

  _currentDir() {
    let dx = 0; let dy = 0;
    if (this.pressed.has('ArrowLeft')) dx -= 1;
    if (this.pressed.has('ArrowRight')) dx += 1;
    if (this.pressed.has('ArrowUp')) dy -= 1;
    if (this.pressed.has('ArrowDown')) dy += 1;
    if (dx === 0 && dy === 0) return null;
    return [dx, dy];
  }

  // Send a manual-driving command for the selected vehicle when the keys change.
  _emit() {
    const v = this.selected;
    if (!v) return;
    const dir = this._currentDir();
    const k = dir ? dir.join(',') : 'none';
    // only start sending once a key is actually pressed; then keep it manual
    if (!dir && this._manualLabel !== v.label) return;
    if (k === this._lastKey && this._manualLabel === v.label) return;
    this.onControl?.(v.label, { dir });
    this._manualLabel = v.label;
    this._lastKey = k;
  }

  _loop(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    const k = Math.min(1, dt * 14);           // position smoothing toward target

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    applyCamera(ctx, this.dpr);

    if (this.selectionRect) {
      const r = this.selectionRect;
      ctx.strokeStyle = '#ffd83b';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }

    this._drawDebug(ctx);
    this._drawMoveMarkers(ctx);
    this._drawPrepLines(ctx);

    // Cull vehicles outside the viewport (cheap when zoomed in). The lerp still
    // runs for everyone so positions stay correct when they scroll back in.
    const cssW = this.cssW ?? this.canvas.width / this.dpr;
    const cssH = this.cssH ?? this.canvas.height / this.dpr;
    const vr = visibleRect(cssW, cssH);
    for (const v of this.vehicles) {
      v.lerp(k);
      const m = Math.max(v.len, v.wid);
      if (v.x < vr.x0 - m || v.x > vr.x1 + m || v.y < vr.y0 - m || v.y > vr.y1 + m) continue;
      v.draw(ctx, v === this.selected);
    }

    this._drawPayouts(ctx, dt);

    requestAnimationFrame(this._loop);
  }

  // Floating "+$XXX" credit pops over crushers: rise and fade over their lifetime.
  _drawPayouts(ctx, dt) {
    if (!this._payouts.length) return;
    const LIFE = 1.6;
    const s = Math.min(this.grid.zoneW, this.grid.zoneH);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(s * 0.7)}px system-ui`;
    ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    for (const p of this._payouts) {
      p.t += dt;
      const k = Math.min(1, p.t / LIFE);
      const alpha = 1 - k * k;                 // hold bright, fade late
      const y = p.y - s * (0.8 + 3.4 * k);     // drift upward
      const txt = `+$${p.amount.toLocaleString('en-US')}`;
      ctx.globalAlpha = alpha;
      ctx.strokeText(txt, p.x, y);
      ctx.fillStyle = '#39e07a';               // money green
      ctx.fillText(txt, p.x, y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    this._payouts = this._payouts.filter((p) => p.t < LIFE);
  }

  // Fluo-violet path line over the block-row a dozer is currently working, with a
  // U-turn "return" arrow at the end it's heading toward (it sweeps back & forth).
  _drawPrepLines(ctx) {
    const zW = this.grid?.zoneW, zH = this.grid?.zoneH;
    if (!zW) return;
    for (const v of this.vehicles) {
      if (v.type !== 'dozer' || !v.prepLine) continue;
      const p = v.prepLine.split(',');
      const y = +p[0], x0 = +p[1], x1 = +p[2], dir = +p[3];
      if (!Number.isFinite(y)) continue;
      const cy = (2 * y + 1) * zH;
      const cx0 = (2 * x0 + 1) * zW, cx1 = (2 * x1 + 1) * zW;
      const out = dir > 0 ? 1 : -1;
      const endX = out > 0 ? cx1 : cx0;
      const r = zH * 0.9;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(206, 92, 255, 0.95)';      // fluo violet
      ctx.shadowColor = 'rgba(198, 80, 255, 0.95)';      // neon glow
      ctx.shadowBlur = zH * 0.6;
      ctx.lineWidth = Math.max(0.5, zH * 0.078);         // 70% thinner
      ctx.beginPath(); ctx.moveTo(cx0, cy); ctx.lineTo(cx1, cy); ctx.stroke();   // the swept row
      // U-turn back under the line, ending in a short horizontal stub so the arrow-
      // head sits on the stub and never crosses the return curve.
      const stubX = endX - out * r * 0.15, stubY = cy + r;
      const tipX = stubX - out * r * 0.8;
      ctx.beginPath();
      ctx.moveTo(endX, cy);
      ctx.quadraticCurveTo(endX + out * r * 1.25, cy + r * 0.55, stubX, stubY);
      ctx.lineTo(tipX, stubY);
      ctx.stroke();
      // arrowhead at the stub tip, pointing back along the row (barbs lie on the stub)
      const ah = zH * 0.4;
      ctx.beginPath();
      ctx.moveTo(tipX + out * ah, stubY - ah * 0.62);
      ctx.lineTo(tipX, stubY);
      ctx.lineTo(tipX + out * ah, stubY + ah * 0.62);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Flag a move-to destination (world coords) for a vehicle, drawn until it
  // arrives there or is taken over by manual driving.
  setMoveMarker(label, x, y) { this.moveMarkers.set(label, { x, y }); }

  // Reticle + leader line at each active move-to destination.
  _drawMoveMarkers(ctx) {
    if (!this.moveMarkers.size) return;
    const s = Math.min(this.grid.zoneW, this.grid.zoneH);
    for (const [label, m] of this.moveMarkers) {
      const v = this.byLabel.get(label);
      if (!v || this._manualLabel === label || Math.hypot(v.x - m.x, v.y - m.y) < s * 1.2) {
        this.moveMarkers.delete(label);   // gone / overridden / arrived
        continue;
      }
      ctx.save();
      ctx.strokeStyle = 'rgba(108, 182, 255, 0.9)';
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.setLineDash([s * 0.4, s * 0.3]);
      ctx.beginPath(); ctx.moveTo(v.x, v.y); ctx.lineTo(m.x, m.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(m.x, m.y, s * 0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(m.x - s * 0.75, m.y); ctx.lineTo(m.x + s * 0.75, m.y);
      ctx.moveTo(m.x, m.y - s * 0.75); ctx.lineTo(m.x, m.y + s * 0.75);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Debug overlay: neon-green continuous line through the planned route cells,
  // with the destination cells outlined.
  _drawDebug(ctx) {
    const data = this.debugPaths;
    if (!data) return;
    const { zoneW, zoneH } = this.grid;
    const s = Math.min(zoneW, zoneH);
    const NEON = 'rgba(57, 255, 20, 0.95)';
    for (const label in data) {
      const plan = data[label];
      if (!plan) continue;
      const { path, goals } = plan;

      if (path && path.length) {
        ctx.strokeStyle = NEON;
        ctx.lineWidth = Math.max(1.5, s * 0.16);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = NEON;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        path.forEach((c, i) => {
          const x = (c.gx + 0.5) * zoneW;
          const y = (c.gy + 0.5) * zoneH;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      if (goals) {
        ctx.strokeStyle = NEON;
        ctx.lineWidth = 2;
        for (const g of goals) ctx.strokeRect(g.gx * zoneW + 1, g.gy * zoneH + 1, zoneW - 2, zoneH - 2);
      }
    }
  }
}
