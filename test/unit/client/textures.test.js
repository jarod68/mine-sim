// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { texture, textureURL } from '../../../public/components/textures.js';

describe('textures (client)', () => {
  it('builds every texture the roads and the UI theme use', () => {
    for (const kind of ['pit', 'rock', 'concrete', 'pad', 'sandstone', 'hivis', 'gold']) {
      expect(() => texture(kind)).not.toThrow();
      expect(texture(kind)).toBe(texture(kind));            // cached
    }
    expect(typeof textureURL('pit')).toBe('string');
  });
});
