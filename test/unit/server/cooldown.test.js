import { describe, it, expect } from 'vitest';
import { actionCooled, ACTION_COOLDOWN } from '../../../server/ws-router.js';

// Per-action anti-spam gate layered on top of the global rate limiter.
describe('actionCooled', () => {
  it('lets an un-listed action through every time', () => {
    const ws = {};
    expect(actionCooled(ws, 'drill', 0)).toBe(true);
    expect(actionCooled(ws, 'drill', 1)).toBe(true);
  });

  it('blocks a gated action until its interval has elapsed', () => {
    const ws = {};
    const gap = ACTION_COOLDOWN.reset;
    expect(actionCooled(ws, 'reset', 0)).toBe(true);          // first allowed
    expect(actionCooled(ws, 'reset', gap - 1)).toBe(false);   // still cooling
    expect(actionCooled(ws, 'reset', gap)).toBe(true);        // interval elapsed
    expect(actionCooled(ws, 'reset', gap + 1)).toBe(false);   // cooling again
  });

  it('tracks each action independently per socket', () => {
    const ws = {};
    expect(actionCooled(ws, 'reset', 0)).toBe(true);
    expect(actionCooled(ws, 'buyCrusher', 0)).toBe(true);     // different action, not blocked
    expect(actionCooled(ws, 'reset', 0)).toBe(false);
  });
});
