// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Vehicle, Fleet } from '../../../public/components/vehicle.js';
import { fakeCanvas } from './_helpers.js';

const sample = (over = {}) => ({
  label: 'OHT01', type: 'oht', model: 'T264', len: 20, wid: 10,
  gx: 5, gy: 5, x: 50, y: 50, heading: 0,
  load: 0, loadOre: null, payload: 240, bucket: null,
  task: null, digging: false, manual: false, shovel: null, ...over,
});

describe('Vehicle (client render object)', () => {
  it('computes hit/selection radii from its footprint', () => {
    const v = new Vehicle(sample());
    expect(v.hitR).toBeCloseTo(20 * 0.72);
    expect(v.selR).toBeCloseTo(20 * 0.62);
  });

  it('lerps the rendered position toward the server target', () => {
    const v = new Vehicle(sample({ x: 0, y: 0 }));
    v.tx = 10; v.ty = 20;
    v.lerp(0.5);
    expect(v.x).toBe(5);
    expect(v.y).toBe(10);
  });

  it('applyServer updates state and sets position as a target', () => {
    const v = new Vehicle(sample());
    v.applyServer(sample({ x: 99, y: 88, load: 240, heading: 1.5 }));
    expect(v.tx).toBe(99);
    expect(v.ty).toBe(88);
    expect(v.load).toBe(240);
    expect(v.heading).toBe(1.5);
  });

  it('draws every vehicle type (incl. the PR776 dozer) without throwing', () => {
    const ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
    const cases = [
      sample({ type: 'oht', load: 120, loadOre: 'iron', task: { kind: 'dump', progress: 0.5 } }),
      sample({ type: 'excavator', model: 'Liebherr R9400', digging: true }),
      sample({ type: 'pickup', model: 'Light Utility Vehicle' }),
      sample({ type: 'dozer', model: 'Liebherr PR776' }),
    ];
    for (const d of cases) {
      const v = new Vehicle(d);
      expect(() => { v.draw(ctx, true); v.draw(ctx, false); }).not.toThrow();
    }
  });

  it('applyDelta merges only the fields present', () => {
    const v = new Vehicle(sample({ load: 0 }));
    v.applyDelta({ label: 'OHT01', load: 120 });
    expect(v.load).toBe(120);
    expect(v.gx).toBe(5);            // untouched
    v.applyDelta({ x: 200 });         // position is a lerp target, not an instant jump
    expect(v.tx).toBe(200);
    expect(v.x).toBe(50);
  });
});

describe('Fleet', () => {
  let fleet;
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0); // don't start the render loop
    fleet = new Fleet(fakeCanvas(), { w: 400, h: 400 }, { zoneW: 10, zoneH: 10 });
  });

  it('sync creates render objects, then updates them in place', () => {
    fleet.sync([sample()]);
    expect(fleet.vehicles).toHaveLength(1);
    const first = fleet.vehicles[0];
    fleet.sync([sample({ load: 240 })]);
    expect(fleet.vehicles).toHaveLength(1);   // same object, not a duplicate
    expect(fleet.vehicles[0]).toBe(first);
    expect(first.load).toBe(240);
  });

  it('applyDeltas merges partial updates by label', () => {
    fleet.sync([sample()]);
    fleet.applyDeltas([{ label: 'OHT01', load: 60 }]);
    expect(fleet.byLabel.get('OHT01').load).toBe(60);
    fleet.applyDeltas([{ label: 'GHOST', load: 1 }]); // unknown label ignored
    expect(fleet.byLabel.has('GHOST')).toBe(false);
  });

  it('snapToTargets jumps render positions to the server target', () => {
    fleet.sync([sample({ x: 0, y: 0 })]);
    const v = fleet.vehicles[0];
    v.tx = 30; v.ty = 40;
    fleet.snapToTargets();
    expect([v.x, v.y]).toEqual([30, 40]);
  });

  it('selectAt hit-tests by render radius', () => {
    fleet.sync([sample({ x: 50, y: 50 })]);
    expect(fleet.selectAt(50, 50)).toBe(fleet.vehicles[0]);
    expect(fleet.selectAt(300, 300)).toBeNull();
  });

  it('hands a manually-driven vehicle back to the autopilot on deselect', () => {
    fleet.sync([sample()]);
    const released = [];
    fleet.onControl = (label, cmd) => released.push([label, cmd]);
    fleet.selected = fleet.vehicles[0]; // a vehicle is currently selected…
    fleet._manualLabel = 'OHT01';       // …and being driven manually
    fleet.setSelected(null);            // deselect → hand it back
    expect(released).toEqual([['OHT01', { release: true }]]);
    expect(fleet._manualLabel).toBeNull();
  });
});
