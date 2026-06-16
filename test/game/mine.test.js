import { describe, it, expect } from 'vitest';
import {
  generateMine,
  BLOCK_TONNAGE,
  ORE_TYPES,
  ORE_LABELS,
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
