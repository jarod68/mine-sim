// Client-side fleet RENDERER. The simulation (movement, collision, autopilot)
// runs entirely on the server; this module only draws the vehicle snapshots it
// receives and forwards manual-driving commands. Positions are smoothed between
// server updates by lerping toward the latest target.

import { applyCamera, visibleRect, DPR } from './camera.js';
import { COLORS_SOLID } from './mine.js';

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

    // label — kept upright above the vehicle
    ctx.fillStyle = selected ? '#ffd83b' : 'rgba(255, 255, 255, 0.9)';
    ctx.font = 'bold 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.label, 0, -this.selR - (this.task ? 15 : 5));

    ctx.restore();
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
    this.selected = null;
    this.selectionRect = null;
    this.onControl = null;        // (label, { dir }|{ release }) → POST /api/control
    this.onSelect = null;         // (vehicle|null) → UI hook
    this.debugPaths = {};         // { label: { path:[{gx,gy}], goals:[{gx,gy}] } }
    this.moveMarkers = new Map(); // label → { x, y } destination flag for a move-to order
    this.pressed = new Set();
    this._manualLabel = null;     // label we're currently driving manually
    this._lastKey = null;

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
    }
    // keep `selected` reference pointing at the live object
    if (this.selected) this.selected = this.byLabel.get(this.selected.label) || null;
  }

  // Merge live deltas (partial per-vehicle field updates) by label.
  applyDeltas(list) {
    for (const d of list) {
      const v = this.byLabel.get(d.label);
      if (v) v.applyDelta(d);            // unknown labels resolve on next full state
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

    requestAnimationFrame(this._loop);
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

// ── top-down sprites (front toward +x) ───────────────────────────────────────

// Light utility vehicle — construction yellow, with a flashing orange beacon.
function drawPickup(ctx, L, W) {
  ctx.fillStyle = '#111317';
  const ww = W * 0.2;
  const wl = L * 0.2;
  for (const sx of [-L * 0.26, L * 0.26]) {
    for (const sy of [-W / 2 - ww * 0.15, W / 2 - ww * 0.85]) {
      ctx.fillRect(sx - wl / 2, sy, wl, ww);
    }
  }

  ctx.fillStyle = '#f2c218';                 // body — construction yellow
  ctx.beginPath();
  ctx.roundRect(-L / 2, -W / 2, L, W, W * 0.24);
  ctx.fill();

  ctx.fillStyle = '#cf9914';                 // cargo bed (darker yellow)
  ctx.beginPath();
  ctx.roundRect(-L / 2 + L * 0.05, -W * 0.34, L * 0.4, W * 0.68, 1.5);
  ctx.fill();

  ctx.fillStyle = '#f7d65a';                 // cab (lighter yellow)
  ctx.beginPath();
  ctx.roundRect(0, -W * 0.42, L * 0.34, W * 0.84, 1.5);
  ctx.fill();

  ctx.fillStyle = '#1d2a36';                 // windshield
  ctx.beginPath();
  ctx.roundRect(L * 0.2, -W * 0.32, L * 0.12, W * 0.64, 1);
  ctx.fill();

  ctx.fillStyle = '#e6ecf5';                 // bumper
  ctx.fillRect(L * 0.46, -W * 0.32, L * 0.04, W * 0.64);

  // flashing orange beacon (gyrophare) on the left of the cab roof, no outline
  const on = (performance.now() % 700) < 350;
  const bx = L * 0.08;
  const by = -W * 0.25;            // left side of the roof
  const br = Math.min(L, W) * 0.14;
  if (on) { ctx.shadowColor = 'rgba(255, 140, 0, 0.95)'; ctx.shadowBlur = 9; }
  ctx.fillStyle = on ? '#ff9b1a' : '#7a4a12';
  ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
}

// Track dozer (PR776) — white crawler bulldozer. Top view, front toward +x:
//   • front 10% = a wide, very thin blade on its push-arms,
//   • middle 25% = the cab (widest part) with a windshield,
//   • rear 50% = the engine deck (narrower) with louvers + exhaust,
//   • tail = a single ripper shank that hooks into the ground.
function drawDozer(ctx, L, W, modelTag = null) {
  // crawler tracks (dark) down both sides
  ctx.fillStyle = '#15171b';
  const tw = W * 0.28;
  ctx.beginPath(); ctx.roundRect(-L * 0.46, -W / 2, L * 0.9, tw, 2); ctx.fill();
  ctx.beginPath(); ctx.roundRect(-L * 0.46, W / 2 - tw, L * 0.9, tw, 2); ctx.fill();
  ctx.strokeStyle = '#2e3238'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = -L * 0.42; gx < L * 0.42; gx += 3.0) {
    ctx.moveTo(gx, -W / 2); ctx.lineTo(gx, -W / 2 + tw);
    ctx.moveTo(gx, W / 2 - tw); ctx.lineTo(gx, W / 2);
  }
  ctx.stroke();

  // rear ripper — a shank hooking into the ground (top view)
  ctx.strokeStyle = '#3b3e44';
  ctx.lineWidth = Math.max(1.6, W * 0.11);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-L * 0.34, 0);
  ctx.lineTo(-L * 0.45, 0);
  ctx.quadraticCurveTo(-L * 0.53, 0, -L * 0.50, W * 0.18);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // engine deck (rear 50%, narrower) — white with louvers + an exhaust stack
  ctx.fillStyle = '#e8eaed';
  ctx.beginPath(); ctx.roundRect(-L * 0.35, -W * 0.31, L * 0.50, W * 0.62, 2); ctx.fill();
  ctx.strokeStyle = '#9aa0aa'; ctx.lineWidth = Math.max(0.6, W * 0.03);
  ctx.beginPath();
  for (let gx = -L * 0.30; gx <= -L * 0.04; gx += L * 0.05) { ctx.moveTo(gx, -W * 0.2); ctx.lineTo(gx, W * 0.2); }
  ctx.stroke();
  const er = Math.min(L, W) * 0.035;
  ctx.fillStyle = '#2c2f34';
  ctx.beginPath(); ctx.arc(-L * 0.27, -W * 0.23, er, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#6b7077'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(-L * 0.27, -W * 0.23, er, 0, Math.PI * 2); ctx.stroke();

  // cab — a black square (thin white outline) midway between engine deck and blade
  const cabH = W * 0.30;             // half-side (a square ≈ 0.6·W across)
  const cabCx = L * 0.30;            // midway between the engine front and the blade
  ctx.fillStyle = '#111317';
  ctx.beginPath(); ctx.roundRect(cabCx - cabH, -cabH, cabH * 2, cabH * 2, 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = Math.max(0.4, W * 0.025);
  ctx.stroke();

  // flashing beacon (gyrophare) on the cab roof, like the LV (small)
  const on = (performance.now() % 700) < 350;
  const gbr = Math.min(L, W) * 0.042;
  if (on) { ctx.shadowColor = 'rgba(255, 140, 0, 0.95)'; ctx.shadowBlur = 9; }
  ctx.fillStyle = on ? '#ff9b1a' : '#7a4a12';
  ctx.beginPath(); ctx.arc(cabCx, -cabH * 0.42, gbr, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // push-arms + the arm holding the blade (front 10%)
  ctx.fillStyle = '#b9bec5';
  for (const sy of [-W * 0.30, W * 0.30]) { ctx.beginPath(); ctx.roundRect(L * 0.38, sy - W * 0.045, L * 0.10, W * 0.09, 1); ctx.fill(); }
  ctx.fillStyle = '#c7ccd2';
  ctx.beginPath(); ctx.roundRect(L * 0.40, -W * 0.10, L * 0.08, W * 0.20, 1); ctx.fill();

  // blade — wide, very thin steel edge at the very front
  ctx.fillStyle = '#dadfe5';
  ctx.beginPath(); ctx.roundRect(L * 0.46, -W * 0.58, L * 0.055, W * 1.16, 1.5); ctx.fill();
  ctx.fillStyle = '#aeb4bc';
  ctx.fillRect(L * 0.505, -W * 0.58, L * 0.012, W * 1.16);

  // model tag on the engine deck, turned 90° and sitting on its own white pad so
  // nothing (e.g. the louvers) shows through behind it.
  if (modelTag) {
    const fs = Math.max(2, W * 0.12);
    ctx.save();
    ctx.translate(-L * 0.18, 0);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `bold ${fs.toFixed(1)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(modelTag);
    const tw = (m && m.width) || fs * 3;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(-tw / 2 - 1.5, -fs * 0.62, tw + 3, fs * 1.24, 1.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(40, 45, 55, 0.9)';
    ctx.fillText(modelTag, 0, 0);
    ctx.restore();
  }
}

function drawExcavator(ctx, L, W, digging, modelTag) {
  // ── crawler tracks (aligned to travel, static) ──
  ctx.fillStyle = '#15171b';
  const tw = W * 0.26;
  ctx.beginPath(); ctx.roundRect(-L * 0.5, -W / 2, L, tw, 2); ctx.fill();
  ctx.beginPath(); ctx.roundRect(-L * 0.5, W / 2 - tw, L, tw, 2); ctx.fill();
  ctx.strokeStyle = '#2e3238';               // grousers
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = -L * 0.46; gx < L * 0.5; gx += 3.2) {
    ctx.moveTo(gx, -W / 2); ctx.lineTo(gx, -W / 2 + tw);
    ctx.moveTo(gx, W / 2 - tw); ctx.lineTo(gx, W / 2);
  }
  ctx.stroke();

  // ── upper structure: slews + the arm extends/retracts while loading ──
  const t = performance.now() / 1000;
  const swing = digging ? Math.sin(t * 2.4) * 0.5 : 0;                       // turret slew
  const reach = digging ? (Math.sin(t * 2.4 + Math.PI / 2) * 0.5 + 0.5) : 0.45; // dig cycle

  ctx.save();
  ctx.rotate(swing);

  // counterweight (rear) — light grey, extended back almost to the track ends
  ctx.fillStyle = '#d7dadf';
  ctx.beginPath(); ctx.roundRect(-L * 0.48, -W * 0.32, L * 0.16, W * 0.64, 2); ctx.fill();
  // house / turret — white, and a bit LONGER than before (closer to the real one)
  ctx.fillStyle = '#eef0f2';
  ctx.beginPath(); ctx.roundRect(-L * 0.34, -W * 0.34, L * 0.66, W * 0.68, 2); ctx.fill();
  // cab glass near the front of the house
  ctx.fillStyle = '#1d2a36';
  ctx.beginPath(); ctx.roundRect(L * 0.14, -W * 0.28, L * 0.16, W * 0.3, 1); ctx.fill();

  // engine deck at the rear of the turret: louvers (grille) + exhaust stack
  ctx.strokeStyle = '#9aa0aa';
  ctx.lineWidth = Math.max(0.6, W * 0.03);
  ctx.beginPath();
  for (let gx = -L * 0.30; gx <= -L * 0.14; gx += L * 0.045) {
    ctx.moveTo(gx, -W * 0.2); ctx.lineTo(gx, W * 0.2);
  }
  ctx.stroke();
  // exhaust pipe (top view: dark stack with a light rim), offset to one side
  const er = Math.min(L, W) * 0.03;
  ctx.fillStyle = '#2c2f34';
  ctx.beginPath(); ctx.arc(-L * 0.2, -W * 0.3, er, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#6b7077';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(-L * 0.2, -W * 0.3, er, 0, Math.PI * 2); ctx.stroke();

  // boom + stick (grey), extend with reach
  const baseX = L * 0.30;
  const tipX = L * (0.44 + 0.26 * reach);
  const midX = (baseX + tipX) / 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#b9bdc4';
  ctx.lineWidth = W * 0.18;
  ctx.beginPath(); ctx.moveTo(baseX, 0); ctx.lineTo(midX, 0); ctx.stroke();   // boom
  ctx.strokeStyle = '#d2d5da';
  ctx.lineWidth = W * 0.12;
  ctx.beginPath(); ctx.moveTo(midX, 0); ctx.lineTo(tipX, 0); ctx.stroke();    // stick

  // bucket at the tip
  ctx.fillStyle = '#54585f';
  ctx.strokeStyle = '#34373c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(tipX - L * 0.02, -W * 0.13, L * 0.09, W * 0.26, 1.5);
  ctx.fill(); ctx.stroke();

  // tiny model name near the lower edge of the house, clear of the boom, cab,
  // louvers and exhaust. Drawn inside the slew group so it rotates with the
  // turret during the loading animation. (Only legible when zoomed in.)
  if (modelTag) {
    ctx.fillStyle = 'rgba(40, 45, 55, 0.85)';
    ctx.font = `bold ${Math.max(2, W * 0.12).toFixed(1)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(modelTag, -L * 0.04, W * 0.26);
  }

  ctx.restore();
}

// Off-highway haul truck (tomberau), white. Top view, front toward +x:
//   • rear 75% of the length = dump bed (load well tinted by the carried ore),
//   • next ~22% = the canopy ("casquette") attached to the bed, over the cab,
//   • front 3% = the engine nose, in dark grey.
function drawOHT(ctx, L, W, load = 0, oreColor = null, modelTag = null) {
  // tyres (dark), peeking out along the sides
  ctx.fillStyle = '#111317';
  const ww = W * 0.22;
  const wl = L * 0.1;
  const axle = (ax) => {
    for (const sy of [-W / 2 - ww * 0.05, W / 2 - ww * 0.95]) ctx.fillRect(ax - wl / 2, sy, wl, ww);
  };
  axle(L * 0.34);          // front
  axle(-L * 0.06);         // rear dual
  axle(-L * 0.24);

  // white body
  ctx.fillStyle = '#eef0f2';
  ctx.beginPath();
  ctx.roundRect(-L * 0.5, -W / 2, L, W, W * 0.14);
  ctx.fill();

  // dump bed (rear 75%) — load well shows the carried material's colour. Its rear
  // edge is a blunt pyramid across the width: triangle 25% / flat 50% / triangle 25%.
  const fX = L * 0.22;        // front of the well
  const rFlat = -L * 0.47;    // rearmost x (the flat middle)
  const rCorner = -L * 0.40;  // where the rear triangles meet the side walls
  const top = -W * 0.4;
  const bot = W * 0.4;
  ctx.fillStyle = (load > 0 && oreColor) ? oreColor : '#c9ccd1';
  ctx.beginPath();
  ctx.moveTo(fX, top);
  ctx.lineTo(fX, bot);
  ctx.lineTo(rCorner, bot);     // bottom side → start of lower triangle
  ctx.lineTo(rFlat, W * 0.2);   // lower triangle → flat
  ctx.lineTo(rFlat, -W * 0.2);  // flat middle (50%)
  ctx.lineTo(rCorner, top);     // upper triangle → top side
  ctx.closePath();
  ctx.fill();

  // canopy / "casquette" (front ~22%) covering the cab — white
  ctx.fillStyle = '#f7f8fa';
  ctx.beginPath();
  ctx.roundRect(L * 0.25, -W * 0.46, L * 0.22, W * 0.92, W * 0.08);
  ctx.fill();
  // faint cab hint under the canopy
  ctx.fillStyle = 'rgba(40, 55, 70, 0.35)';
  ctx.beginPath();
  ctx.roundRect(L * 0.30, -W * 0.34, L * 0.12, W * 0.68, 1);
  ctx.fill();

  // engine nose — front 3%, dark grey/black
  ctx.fillStyle = '#34373c';
  ctx.beginPath();
  ctx.roundRect(L * 0.47, -W * 0.34, L * 0.03, W * 0.68, 1);
  ctx.fill();

  // tiny model name on the canopy ("casquette"), running across it (zoom to read)
  if (modelTag) {
    ctx.save();
    ctx.translate(L * 0.36, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = 'rgba(40, 45, 55, 0.85)';
    ctx.font = `bold ${Math.max(2, W * 0.22).toFixed(1)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(modelTag, 0, 0);
    ctx.restore();
  }
}
