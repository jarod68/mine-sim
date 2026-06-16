import { describe, it, expect } from 'vitest';
import { ORE_LABELS, COLORS, COLORS_SOLID, BLOCK_TONNAGE } from '../../public/components/mine.js';

describe('client mine palette', () => {
  const ores = ['iron', 'copper', 'gold', 'carbon'];

  it('matches the server block tonnage', () => {
    expect(BLOCK_TONNAGE).toBe(10000);
  });

  it('labels every ore type', () => {
    for (const ore of ores) expect(ORE_LABELS[ore]).toBeTruthy();
  });

  it('provides translucent and solid colours for every cell kind', () => {
    for (const kind of [...ores, 'dirt', 'unexplored']) {
      expect(COLORS[kind]).toMatch(/rgba?\(/);
      expect(COLORS_SOLID[kind]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
