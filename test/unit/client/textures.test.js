// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { BLOCK_TEXTURE, CRACK_TEXELS, TEX, texture } from '../../../public/components/textures.js';
import { COLORS } from '../../../public/components/mine.js';

describe('textures (client)', () => {
  it('maps every mine material to a texture, with a flat fallback colour', () => {
    for (const kind of Object.keys(COLORS)) {
      expect(BLOCK_TEXTURE[kind]).toBeTruthy();
      expect(() => texture(BLOCK_TEXTURE[kind])).not.toThrow();
    }
  });

  it('crack texels are unique, inside the tile and plentiful enough to show progress', () => {
    const keys = new Set(CRACK_TEXELS.map(([x, y]) => `${x},${y}`));
    expect(keys.size).toBe(CRACK_TEXELS.length);
    expect(CRACK_TEXELS.length).toBeGreaterThanOrEqual(30);
    for (const [x, y] of CRACK_TEXELS) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(TEX);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(TEX);
    }
  });
});
