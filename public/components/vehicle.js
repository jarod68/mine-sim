// Fleet of grid-driven vehicles, rendered top-down on an overlay layer.
//
// Vehicles always travel centered on the sub-zone grid (a sub-zone is a quarter
// of a mining block): they step from one cell centre to the next, never
// off-centre. Click a vehicle to select it (highlighted outline); only the
// selected vehicle responds to the arrow keys. The excavator is 4× slower than
// the light pickup.

import { applyCamera } from './camera.js';
import { COLORS_SOLID } from './mine.js';

const BASE_SPEED = 168; // px/s for the light vehicle

const KEY_DIRS = {
  ArrowUp:    [0, -1],
  ArrowDown:  [0, 1],
  ArrowLeft:  [-1, 0],
  ArrowRight: [1, 0],
};
// Single-direction priority when several arrows are held (4-way grid driving).
const KEY_PRIORITY = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

// Per-type model + technical specs (shown in the Asset details panel).
const SPECS = {
  pickup:    { model: 'Light Utility Vehicle' },
  excavator: { model: 'Liebherr R9100', bucket: 24 },
  oht:       { model: 'Liebherr T264', payload: 240 },
};

export class Vehicle {
  constructor({ type, label, gx, gy, len, wid }) {
    this.type = type;
    this.label = label;
    this.gx = gx;            // current sub-zone cell
    this.gy = gy;
    this.tgx = gx;           // target cell while moving
    this.tgy = gy;
    this.len = len;
    this.wid = wid;
    this.speed = type === 'excavator' ? BASE_SPEED / 4
      : type === 'oht' ? BASE_SPEED / 2
      : BASE_SPEED;
    this.roadOnly = type === 'oht';
    const spec = SPECS[type] || {};
    this.model = spec.model || type;
    this.payload = spec.payload || null;
    this.bucket = spec.bucket || null;
    this.x = 0;              // pixel centre (set by Fleet.add once grid is known)
    this.y = 0;
    this.heading = 0;        // radians; 0 = facing right
    this.moving = false;
    this.load = 0;           // tonnes carried (OHT)
    this.loadOre = null;     // ore type carried
    this.task = null;        // { kind:'load'|'dump', progress } during auto wait
    this.digging = false;    // shovel actively loading a truck (drives animation)
    this.manual = false;     // player is driving it (keyboard) — bypass autopilot
    this.hitR = Math.max(len, wid) * 0.72;
    this.selR = Math.max(len, wid) * 0.62;
  }

  update(dt, dir, grid, isRoad, isFree) {
    if (this.moving) {
      const tx = (this.tgx + 0.5) * grid.zoneW;
      const ty = (this.tgy + 0.5) * grid.zoneH;
      const dx = tx - this.x;
      const dy = ty - this.y;
      const dist = Math.hypot(dx, dy);
      const step = this.speed * dt;
      if (dist <= step) {
        this.x = tx;
        this.y = ty;
        this.gx = this.tgx;
        this.gy = this.tgy;
        this.moving = false;
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }
    }

    if (!this.moving && dir) {
      const [dx, dy] = dir;
      this.heading = Math.atan2(dy, dx);
      const nx = this.gx + dx;
      const ny = this.gy + dy;
      const inBounds = nx >= 0 && nx < grid.zoneCols && ny >= 0 && ny < grid.zoneRows;
      // OHTs may only drive on roads (incl. parking pads) — unless under manual
      // control, where the player can drive anywhere, even off-road.
      const onRoad = !this.roadOnly || this.manual || (isRoad && isRoad(nx, ny));
      // The WHOLE vehicle (its full footprint at the target, cab included) must
      // be clear of other vehicles — not just its centre cell.
      const cells = this.cellsAround(nx, ny, { dx, dy }, grid);
      const free = !isFree || cells.every((c) => isFree(c.gx, c.gy, this));
      if (inBounds && onRoad && free) {
        this.tgx = nx;
        this.tgy = ny;
        this.moving = true;
      }
    }
  }

  // Grid cells this vehicle covers when its head is at (gx,gy) facing `dir`.
  // Long vehicles (OHT) extend backward from the head along the heading.
  cellsAround(gx, gy, dir, grid) {
    const zone = Math.min(grid.zoneW, grid.zoneH);
    const lenCells = Math.max(1, Math.round(this.len / zone));
    const cells = [];
    for (let i = 0; i < lenCells; i++) cells.push({ gx: gx - dir.dx * i, gy: gy - dir.dy * i });
    return cells;
  }

  // Cells currently occupied (footprint at the current cell, plus the reserved
  // target footprint while moving) — used by others for collision.
  occupiedCells(grid) {
    const dir = { dx: Math.round(Math.cos(this.heading)), dy: Math.round(Math.sin(this.heading)) };
    const cells = this.cellsAround(this.gx, this.gy, dir, grid);
    if (this.moving) for (const c of this.cellsAround(this.tgx, this.tgy, dir, grid)) cells.push(c);
    return cells;
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

    ctx.save();
    ctx.rotate(this.heading);
    if (this.type === 'excavator') drawExcavator(ctx, this.len, this.wid, this.digging);
    else if (this.type === 'oht') {
      const oreColor = this.loadOre ? COLORS_SOLID[this.loadOre] : null;
      drawOHT(ctx, this.len, this.wid, this.load, oreColor);
    } else drawPickup(ctx, this.len, this.wid);
    ctx.restore();

    // payload fill % on the dump bed (upright over the bed, which sits at the
    // rear −x of the truck; rotate the offset so it tracks the heading).
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
    this.dpr = window.devicePixelRatio || 1;
    this.vehicles = [];
    this.selected = null;
    this.roads = null;
    this.autopilot = null;
    this.selectionRect = null;   // { x, y, w, h } logical block outline
    this.pressed = new Set();

    window.addEventListener('keydown', (e) => {
      if (!KEY_DIRS[e.key]) return;
      this.pressed.add(e.key);
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (!KEY_DIRS[e.key]) return;
      this.pressed.delete(e.key);
      e.preventDefault();
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

  setRoads(roads) {
    this.roads = roads;
  }

  setAutopilot(autopilot) {
    this.autopilot = autopilot;
  }

  add(vehicle) {
    vehicle.x = (vehicle.gx + 0.5) * this.grid.zoneW;
    vehicle.y = (vehicle.gy + 0.5) * this.grid.zoneH;
    this.vehicles.push(vehicle);
    if (!this.selected) this.selected = vehicle;
  }

  // A cell is free if it is outside every other vehicle's footprint (current +
  // reserved target), so the whole vehicle — cab included — avoids overlaps.
  _isFree(gx, gy, self) {
    for (const v of this.vehicles) {
      if (v === self) continue;
      for (const c of v.occupiedCells(this.grid)) {
        if (c.gx === gx && c.gy === gy) return false;
      }
    }
    return true;
  }

  // Returns the vehicle (and selects it) under the given canvas point, or null.
  selectAt(px, py) {
    for (const v of this.vehicles) {
      if (Math.hypot(px - v.x, py - v.y) <= v.hitR) {
        this.selected = v;
        return v;
      }
    }
    return null;
  }

  _currentDir(allowDiagonal) {
    let dx = 0;
    let dy = 0;
    if (this.pressed.has('ArrowLeft')) dx -= 1;
    if (this.pressed.has('ArrowRight')) dx += 1;
    if (this.pressed.has('ArrowUp')) dy -= 1;
    if (this.pressed.has('ArrowDown')) dy += 1;
    if (dx === 0 && dy === 0) return null;
    if (!allowDiagonal && dx !== 0 && dy !== 0) dy = 0; // single axis (4-way)
    return [dx, dy];
  }

  _loop(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;

    // A deselected truck resumes autopilot; a deselected manual shovel stays
    // manual (it keeps the position the player chose, no auto-relocation).
    if (this._prevSelected && this._prevSelected !== this.selected) {
      const prev = this._prevSelected;
      if (prev.manual && prev.type === 'oht') {
        prev.manual = false;
        if (this.autopilot) this.autopilot.clearManual(prev);
      }
    }
    this._prevSelected = this.selected;

    // The selected vehicle may move diagonally (incl. trucks driven manually
    // off-road); autopilot-driven trucks stay 4-way on the roads.
    const sel = this.selected;
    const allowDiagonal = !!sel;
    const kbDir = sel ? this._currentDir(allowDiagonal) : null;
    const isRoad = this.roads ? (gx, gy) => this.roads.isRoad(gx, gy) : null;
    const isFree = (gx, gy, self) => this._isFree(gx, gy, self);

    if (this.autopilot) {
      this.autopilot.isFree = isFree;
      this.autopilot.update(dt);
    }

    for (const v of this.vehicles) {
      let dir = null;
      // Driving the selected vehicle with the keyboard takes over: it switches
      // to manual (autopilot released) and follows the arrows until deselected.
      if (v === sel && kbDir) {
        if (this.autopilot) this.autopilot.setManual(v);
        v.manual = true;
        dir = kbDir;
      } else if (this.autopilot && this.autopilot.controls(v)) {
        dir = this.autopilot.dirFor(v);
      } else if (v === sel) {
        dir = kbDir; // selected, idle (no autopilot, no keys) → hold
      }
      v.update(dt, dir, this.grid, isRoad, isFree);
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    applyCamera(ctx, this.dpr);

    // block selection outline (above the roads)
    if (this.selectionRect) {
      const r = this.selectionRect;
      ctx.strokeStyle = '#ffd83b';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    }

    for (const v of this.vehicles) v.draw(ctx, v === this.selected);

    requestAnimationFrame(this._loop);
  }
}

// ── top-down sprites (front toward +x) ───────────────────────────────────────

function drawPickup(ctx, L, W) {
  ctx.fillStyle = '#111317';
  const ww = W * 0.2;
  const wl = L * 0.2;
  for (const sx of [-L * 0.26, L * 0.26]) {
    for (const sy of [-W / 2 - ww * 0.15, W / 2 - ww * 0.85]) {
      ctx.fillRect(sx - wl / 2, sy, wl, ww);
    }
  }

  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.roundRect(-L / 2, -W / 2, L, W, W * 0.24);
  ctx.fill();

  ctx.fillStyle = '#2461bd';                 // cargo bed
  ctx.beginPath();
  ctx.roundRect(-L / 2 + L * 0.05, -W * 0.34, L * 0.4, W * 0.68, 1.5);
  ctx.fill();

  ctx.fillStyle = '#5b9bf7';                 // cab
  ctx.beginPath();
  ctx.roundRect(0, -W * 0.42, L * 0.34, W * 0.84, 1.5);
  ctx.fill();

  ctx.fillStyle = '#1d2a36';                 // windshield
  ctx.beginPath();
  ctx.roundRect(L * 0.2, -W * 0.32, L * 0.12, W * 0.64, 1);
  ctx.fill();

  ctx.fillStyle = '#e6ecf5';                 // bumper
  ctx.fillRect(L * 0.46, -W * 0.32, L * 0.04, W * 0.64);
}

function drawExcavator(ctx, L, W, digging) {
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

  // counterweight (rear)
  ctx.fillStyle = '#cf9914';
  ctx.beginPath(); ctx.roundRect(-L * 0.34, -W * 0.3, L * 0.13, W * 0.6, 2); ctx.fill();
  // house
  ctx.fillStyle = '#f2b81c';
  ctx.beginPath(); ctx.roundRect(-L * 0.26, -W * 0.32, L * 0.5, W * 0.64, 2); ctx.fill();
  // cab glass
  ctx.fillStyle = '#1d2a36';
  ctx.beginPath(); ctx.roundRect(L * 0.04, -W * 0.28, L * 0.16, W * 0.28, 1); ctx.fill();

  // boom + stick (extend with reach)
  const baseX = L * 0.18;
  const tipX = L * (0.34 + 0.26 * reach);
  const midX = (baseX + tipX) / 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#e0a92a';
  ctx.lineWidth = W * 0.18;
  ctx.beginPath(); ctx.moveTo(baseX, 0); ctx.lineTo(midX, 0); ctx.stroke();   // boom
  ctx.strokeStyle = '#f2c24a';
  ctx.lineWidth = W * 0.12;
  ctx.beginPath(); ctx.moveTo(midX, 0); ctx.lineTo(tipX, 0); ctx.stroke();    // stick

  // bucket at the tip
  ctx.fillStyle = '#54585f';
  ctx.strokeStyle = '#34373c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(tipX - L * 0.02, -W * 0.13, L * 0.09, W * 0.26, 1.5);
  ctx.fill(); ctx.stroke();

  ctx.restore();
}

// Off-highway haul truck (tomberau) — long, dump bed at the rear (−x), cab and
// grille at the front (+x), dual rear axles. `oreColor` tints the load well with
// the carried material's colour.
function drawOHT(ctx, L, W, load = 0, oreColor = null) {
  // tyres
  ctx.fillStyle = '#111317';
  const ww = W * 0.24;
  const wl = L * 0.12;
  const axle = (ax) => {
    for (const sy of [-W / 2 - ww * 0.08, W / 2 - ww * 0.92]) {
      ctx.fillRect(ax - wl / 2, sy, wl, ww);
    }
  };
  axle(L * 0.3);           // front (steer)
  axle(-L * 0.1);          // rear dual
  axle(-L * 0.26);

  // dump bed (rear) with a load well that shows the carried material's colour
  ctx.fillStyle = '#d39a26';
  ctx.beginPath();
  ctx.roundRect(-L * 0.5, -W / 2, L * 0.64, W, W * 0.18);
  ctx.fill();
  ctx.fillStyle = (load > 0 && oreColor) ? oreColor : '#6f5a1c';
  ctx.beginPath();
  ctx.roundRect(-L * 0.45, -W * 0.36, L * 0.5, W * 0.72, 2);
  ctx.fill();

  // hood / chassis (front)
  ctx.fillStyle = '#e0a32a';
  ctx.beginPath();
  ctx.roundRect(L * 0.08, -W * 0.34, L * 0.42, W * 0.68, W * 0.12);
  ctx.fill();

  // cab
  ctx.fillStyle = '#f0c350';
  ctx.beginPath();
  ctx.roundRect(L * 0.1, -W * 0.36, L * 0.16, W * 0.72, 1.5);
  ctx.fill();

  // windshield
  ctx.fillStyle = '#1d2a36';
  ctx.beginPath();
  ctx.roundRect(L * 0.19, -W * 0.28, L * 0.08, W * 0.56, 1);
  ctx.fill();

  // grille / lights
  ctx.fillStyle = '#e6ecf5';
  ctx.fillRect(L * 0.49, -W * 0.3, L * 0.03, W * 0.6);
}
