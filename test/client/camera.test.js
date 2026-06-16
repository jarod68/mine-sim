import { describe, it, expect, beforeEach } from 'vitest';
import { camera, applyCamera, toWorld } from '../../public/components/camera.js';

describe('camera', () => {
  beforeEach(() => { camera.scale = 1; camera.ox = 0; camera.oy = 0; });

  it('toWorld is the identity at the default transform', () => {
    const rect = { left: 0, top: 0 };
    expect(toWorld(40, 25, rect)).toEqual({ x: 40, y: 25 });
  });

  it('toWorld undoes pan and zoom', () => {
    camera.scale = 2; camera.ox = 10; camera.oy = 20;
    const rect = { left: 5, top: 5 };
    // screen = world*scale + offset + rect → invert it
    expect(toWorld(35, 45, rect)).toEqual({ x: (35 - 5 - 10) / 2, y: (45 - 5 - 20) / 2 });
  });

  it('applyCamera writes the dpr*scale transform with the pan offset', () => {
    camera.scale = 3; camera.ox = 7; camera.oy = 9;
    let args = null;
    const ctx = { setTransform: (...a) => { args = a; } };
    applyCamera(ctx, 2); // dpr = 2
    expect(args).toEqual([6, 0, 0, 6, 14, 18]); // [dpr*scale,0,0,dpr*scale,dpr*ox,dpr*oy]
  });
});
