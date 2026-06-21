// Vehicle physics: cell-stepped movement on the sub-zone grid + the collision
// footprint other vehicles reserve. Pure of game rules beyond its own constants.

const { BASE_SPEED, SPECS, TRUCK_COLLISION_SCALE } = require('./constants');

class Vehicle {
  constructor({ type, label, gx, gy, len, wid, model, bucket, payload }) {
    this.type = type;
    this.label = label;
    this.gx = gx; this.gy = gy;
    this.tgx = gx; this.tgy = gy;
    // The cell physically left on the current/last move — used by the autopilot
    // to forbid immediate U-turns (anti-oscillation).
    this.fromGx = gx; this.fromGy = gy;
    this.len = len; this.wid = wid;
    this.speed = type === 'excavator' ? BASE_SPEED / 4
      : type === 'dozer' ? BASE_SPEED / 3
      : type === 'oht' ? BASE_SPEED / 2
      : type === 'grader' ? BASE_SPEED * 0.6   // 40% slower than a light vehicle
      : BASE_SPEED;
    this.roadOnly = type === 'oht';
    const spec = SPECS[type] || {};
    this.model = model || spec.model || type;
    this.payload = payload ?? spec.payload ?? null;
    this.bucket = bucket ?? spec.bucket ?? null;
    this.x = 0; this.y = 0;
    this.heading = 0;
    // Speed factor for the current cell (set by the world each tick; 1 = normal,
    // <1 over a degraded road segment).
    this.speedMul = 1;
    this.moving = false;
    this.load = 0;
    this.loadOre = null;
    this.task = null;
    this.digging = false;
    this.manual = false;
    this.manualDir = null;
    // Autopilot may steer this vehicle off the road (truck docking to a shovel).
    this.offroad = false;
    // Collision footprint multiplier (see TRUCK_COLLISION_SCALE). 1 = full body.
    this.collisionScale = type === 'oht' ? TRUCK_COLLISION_SCALE : 1;
  }

  place(grid) {
    this.x = (this.gx + 0.5) * grid.zoneW;
    this.y = (this.gy + 0.5) * grid.zoneH;
  }

  update(dt, dir, grid, isRoad, isFree) {
    if (this.moving) {
      const tx = (this.tgx + 0.5) * grid.zoneW;
      const ty = (this.tgy + 0.5) * grid.zoneH;
      const dx = tx - this.x;
      const dy = ty - this.y;
      const dist = Math.hypot(dx, dy);
      const step = this.speed * (this.speedMul || 1) * dt;
      if (dist <= step) {
        this.x = tx; this.y = ty;
        this.gx = this.tgx; this.gy = this.tgy;
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
      const onRoad = !this.roadOnly || this.manual || this.offroad || (isRoad && isRoad(nx, ny));
      const cells = this.collisionCells(nx, ny, grid, this.heading);
      const free = !isFree || cells.every((c) => isFree(c.gx, c.gy, this));
      if (inBounds && onRoad && free) {
        this.fromGx = this.gx; this.fromGy = this.gy;
        this.tgx = nx; this.tgy = ny;
        this.moving = true;
      }
    }
  }

  // Every grid cell the vehicle's graphic footprint overlaps when centred on cell
  // (gx,gy): the axis-aligned bounds of its (len × wid) body rotated by `heading`.
  // Collision reserves exactly these cells, so two vehicles never share one — and
  // therefore their sprites never overlap.
  footprintAt(gx, gy, grid, heading = this.heading, scale = 1) {
    const c = Math.abs(Math.cos(heading));
    const s = Math.abs(Math.sin(heading));
    const len = this.len * scale, wid = this.wid * scale;
    const hx = (c * len + s * wid) / 2;   // half-extents of the AABB (px)
    const hy = (s * len + c * wid) / 2;
    const cx = (gx + 0.5) * grid.zoneW;
    const cy = (gy + 0.5) * grid.zoneH;
    const x0 = Math.floor((cx - hx) / grid.zoneW);
    const x1 = Math.ceil((cx + hx) / grid.zoneW) - 1;
    const y0 = Math.floor((cy - hy) / grid.zoneH);
    const y1 = Math.ceil((cy + hy) / grid.zoneH) - 1;
    const cells = [];
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) cells.push({ gx: xx, gy: yy });
    return cells;
  }

  // Cells this vehicle's collision reserves when centred on (gx,gy) facing
  // `heading`: its (possibly shrunk) body footprint, plus — for haul trucks — the
  // single cell directly BEHIND it. The rear cell forces a follower to leave a
  // body-length gap (so two truck sprites never touch) while keeping the cell
  // AHEAD free, so a truck can still pull right up against a shovel or crusher.
  collisionCells(gx, gy, grid, heading = this.heading) {
    const s = this.collisionScale;
    const cells = this.footprintAt(gx, gy, grid, heading, s);
    if (this.type === 'oht') {
      const bx = -Math.round(Math.cos(heading));
      const by = -Math.round(Math.sin(heading));
      for (const c of this.footprintAt(gx + bx, gy + by, grid, heading, s)) cells.push(c);
    }
    return cells;
  }

  occupiedCells(grid) {
    const cells = this.collisionCells(this.gx, this.gy, grid, this.heading);
    if (this.moving) for (const c of this.collisionCells(this.tgx, this.tgy, grid, this.heading)) cells.push(c);
    return cells;
  }

  // ── persistence ──
  // The single place that defines a vehicle's saved shape: add a persisted field
  // here (and in the constructor) and both save and restore pick it up.
  toSnapshot() {
    return {
      type: this.type, label: this.label, gx: this.gx, gy: this.gy, heading: this.heading,
      len: this.len, wid: this.wid, model: this.model, bucket: this.bucket, payload: this.payload,
      load: this.load, loadOre: this.loadOre, manual: this.manual,
    };
  }

  static fromSnapshot(d, grid) {
    const v = new Vehicle({
      type: d.type, label: d.label, gx: d.gx, gy: d.gy,
      len: d.len, wid: d.wid, model: d.model, bucket: d.bucket, payload: d.payload,
    });
    v.heading = d.heading || 0;
    v.load = d.load || 0;
    v.loadOre = d.loadOre || null;
    v.manual = !!d.manual;
    if (grid) v.place(grid);
    return v;
  }
}

module.exports = { Vehicle };
