import { describe, it, expect } from 'vitest';
import {
  generateMine,
  rebuildPrepZones,
  BLOCK_TONNAGE,
  ORE_TYPES,
  ORE_LABELS,
  PREP_PASSES,
  PREP_ZONE_AREA,
  PREP_ZONE_COUNT,
} from '../../game/mine.js';

describe('mine constants', () => {
  it('block tonnage is 10 000 t', () => {
    expect(BLOCK_TONNAGE).toBe(10000);
  });

  it('every ore type has a human label', () => {
    expect(ORE_TYPES).toEqual(['iron', 'copper', 'gold', 'carbon']);
    for (const ore of ORE_TYPES) expect(typeof ORE_LABELS[ore]).toBe('string');
  });
});

describe('generateMine', () => {
  const cols = 30;
  const rows = 20;
  const mine = generateMine(cols, rows);

  it('returns a grid of the requested size', () => {
    expect(mine.cols).toBe(cols);
    expect(mine.rows).toBe(rows);
    expect(mine.blocks).toHaveLength(rows);
    for (const row of mine.blocks) expect(row).toHaveLength(cols);
  });

  it('tags each block with its own coordinates', () => {
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        expect(mine.blocks[y][x].x).toBe(x);
        expect(mine.blocks[y][x].y).toBe(y);
      }
  });

  it('starts every block unexplored with four sub-zones', () => {
    for (const row of mine.blocks)
      for (const b of row) {
        expect(b.explored).toBe(false);
        expect(b.zones).toEqual([null, null, null, null]);
        expect(b.tonnage).toBe(BLOCK_TONNAGE);
      }
  });

  it('keeps dirt + ore mass consistent for every block', () => {
    for (const row of mine.blocks)
      for (const b of row) {
        expect(b.oreRemaining + b.dirtRemaining).toBe(BLOCK_TONNAGE);
        expect(b.orePct + b.dirtPct).toBe(100);
        if (b.ore) {
          expect(ORE_TYPES).toContain(b.ore);
          expect(b.orePct).toBeGreaterThan(0);
          expect(b.oreRemaining).toBe(Math.round((BLOCK_TONNAGE * b.orePct) / 100));
        } else {
          expect(b.orePct).toBe(0);
          expect(b.oreRemaining).toBe(0);
        }
      }
  });

  it('lays down a meaningful amount of ore (deposits actually grow)', () => {
    let oreCells = 0;
    for (const row of mine.blocks) for (const b of row) if (b.ore) oreCells++;
    expect(oreCells).toBeGreaterThan(0);
    expect(oreCells).toBeLessThan(cols * rows); // never the whole map
  });

  it('handles a tiny map without throwing', () => {
    expect(() => generateMine(1, 1)).not.toThrow();
    const tiny = generateMine(2, 2);
    expect(tiny.blocks).toHaveLength(2);
  });
});

describe('rich prep veins', () => {
  const mine = generateMine(190, 139);   // full-size map: room for every zone

  // index every prep block by its zone id
  function zoneBlocks() {
    const byId = new Map();
    for (const row of mine.blocks)
      for (const b of row) if (b.prep) (byId.get(b.prepZone) || byId.set(b.prepZone, []).get(b.prepZone)).push(b);
    return byId;
  }

  it('stamps PREP_ZONE_COUNT zones, all of equal area PREP_ZONE_AREA', () => {
    expect(mine.prepZones).toHaveLength(PREP_ZONE_COUNT);
    const byId = zoneBlocks();
    expect(byId.size).toBe(PREP_ZONE_COUNT);
    for (const [, blocks] of byId) expect(blocks).toHaveLength(PREP_ZONE_AREA);
    for (const z of mine.prepZones) expect(z.remaining).toBe(PREP_ZONE_AREA);
  });

  it('produces irregular shapes (bounding boxes are not all identical)', () => {
    const dims = mine.prepZones.map((z) => `${z.x1 - z.x0 + 1}x${z.y1 - z.y0 + 1}`);
    expect(new Set(dims).size).toBeGreaterThan(1);       // width/height vary
    // an irregular blob's bounding box is larger than its (equal) area
    for (const z of mine.prepZones)
      expect((z.x1 - z.x0 + 1) * (z.y1 - z.y0 + 1)).toBeGreaterThanOrEqual(PREP_ZONE_AREA);
  });

  it('never lets two zones share or touch (8-adjacency) a block', () => {
    for (const row of mine.blocks)
      for (const b of row) {
        if (!b.prep) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const n = mine.blocks[b.y + dy]?.[b.x + dx];
            if (n && n.prep) expect(n.prepZone).toBe(b.prepZone);   // same zone only
          }
      }
  });

  it('fills every prep block with rich, hidden, un-prepared ore', () => {
    for (const row of mine.blocks)
      for (const b of row) {
        if (!b.prep) continue;
        expect(b.explored).toBe(false);
        expect(b.prepDone).toBe(false);
        expect(b.prepPasses).toBe(0);
        expect(b.prepMax).toBe(PREP_PASSES);
        expect(ORE_TYPES).toContain(b.ore);     // always carries ore
        expect(b.orePct).toBeGreaterThan(0);
      }
  });

  it('rebuilds the same zone rectangles from the grid alone', () => {
    const rebuilt = rebuildPrepZones(mine.blocks);
    expect(rebuilt).toHaveLength(mine.prepZones.length);
    for (let i = 0; i < rebuilt.length; i++) {
      const a = mine.prepZones[i], b = rebuilt[i];
      expect([b.x0, b.y0, b.x1, b.y1]).toEqual([a.x0, a.y0, a.x1, a.y1]);
      expect(b.remaining).toBe(a.remaining);
    }
  });
});
