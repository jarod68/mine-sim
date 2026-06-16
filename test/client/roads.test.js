import { describe, it, expect, beforeEach } from 'vitest';
import { Roads } from '../../public/components/roads.js';
import { fakeCanvas } from './_helpers.js';

const grid = { zoneW: 10, zoneH: 10, zoneCols: 40, zoneRows: 40 };
const makeRoads = () => new Roads(fakeCanvas(), { w: 400, h: 400 }, grid);

describe('Roads editor (client)', () => {
  let roads;
  beforeEach(() => { roads = makeRoads(); });

  it('serializes drawn cells but not parking pads', () => {
    roads.addParking(0, 0, 2, 2);
    roads.load([{ gx: 5, gy: 5, dir: { dx: 1, dy: 0 } }]);
    expect(roads.serialize()).toEqual([{ gx: 5, gy: 5, dir: { dx: 1, dy: 0 } }]);
    expect(roads.isRoad(0, 0)).toBe(true);
  });

  it('setNetwork swaps the network while keeping parking', () => {
    roads.addParking(0, 0, 1, 1);
    roads.load([{ gx: 5, gy: 5 }]);
    roads.setNetwork([{ gx: 9, gy: 9 }]);
    expect(roads.isRoad(5, 5)).toBe(false);
    expect(roads.isRoad(9, 9)).toBe(true);
    expect(roads.isRoad(0, 0)).toBe(true);
  });

  it('invert flips every arrow', () => {
    roads.load([{ gx: 5, gy: 5, dir: { dx: 1, dy: 0 } }]);
    roads.invert();
    const { dx, dy } = roads.serialize()[0].dir;
    expect(dx).toBe(-1);
    expect(Math.abs(dy)).toBe(0); // -0 is fine
  });

  it('invert flips a vertical arrow too', () => {
    roads.load([{ gx: 5, gy: 5, dir: { dx: 0, dy: 1 } }]);
    roads.invert();
    expect(roads.serialize()[0].dir.dy).toBe(-1);
  });

  it('clear removes the whole network', () => {
    roads.load([{ gx: 5, gy: 5 }]);
    roads.clear();
    expect(roads.serialize()).toEqual([]);
  });

  it('_stroke lays a continuous run carrying the stroke direction', () => {
    roads.last = { gx: 5, gy: 5 };
    roads._stroke(5, 5, { gx: 8, gy: 5 }, 'draw');
    for (let x = 5; x <= 8; x++) expect(roads.isRoad(x, 5)).toBe(true);
    expect(roads.cells.get('7,5').dir).toEqual({ dx: 1, dy: 0 });
  });

  it('_stroke in erase mode removes cells (but keeps parking)', () => {
    roads.addParking(5, 5, 1, 1);
    roads.load([{ gx: 6, gy: 5 }, { gx: 7, gy: 5 }]);
    roads.last = { gx: 5, gy: 5 };
    roads._stroke(5, 5, { gx: 7, gy: 5 }, 'erase');
    expect(roads.isRoad(6, 5)).toBe(false);
    expect(roads.isRoad(5, 5)).toBe(true); // parking survives
  });

  it('recognises a 4-way junction and its exits', () => {
    roads.load([
      { gx: 5, gy: 5 }, { gx: 4, gy: 5 }, { gx: 6, gy: 5 }, { gx: 5, gy: 4 }, { gx: 5, gy: 6 },
    ]);
    const c = roads.cells.get('5,5');
    expect(roads._isJunction(c)).toBe(true);
    expect(roads._exits(c)).toHaveLength(4); // every direction open (no arrows)
  });

  it('_exits omits a neighbour you would enter against its flow', () => {
    roads.load([
      { gx: 5, gy: 5 },
      { gx: 6, gy: 5, dir: { dx: -1, dy: 0 } }, // points back toward 5,5
      { gx: 4, gy: 5 }, { gx: 5, gy: 6 },
    ]);
    const exits = roads._exits(roads.cells.get('5,5')).map((d) => d.join(','));
    expect(exits).not.toContain('1,0'); // can't go east into a westbound cell
    expect(exits).toContain('-1,0');
  });

  it('_incomingDir finds the cell flowing into a target', () => {
    roads.load([{ gx: 4, gy: 5, dir: { dx: 1, dy: 0 } }, { gx: 5, gy: 5 }]);
    expect(roads._incomingDir(roads.cells.get('5,5'))).toEqual({ dx: 1, dy: 0 });
  });
});
