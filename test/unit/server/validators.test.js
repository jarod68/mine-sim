import { describe, it, expect } from 'vitest';
import { validateLobby, validateCommand, MAX_ROAD_CELLS } from '../../../server/validators.js';

const bounds = { cols: 10, rows: 8, zoneCols: 20, zoneRows: 16 };

describe('validators — lobby', () => {
  it('accepts create and a sane join code', () => {
    expect(validateLobby({ t: 'create' })).toEqual({ t: 'create' });
    expect(validateLobby({ t: 'join', room: 'ABCDE' })).toEqual({ t: 'join', room: 'ABCDE' });
  });
  it('rejects a missing or oversized join code', () => {
    expect(validateLobby({ t: 'join' })).toBeNull();
    expect(validateLobby({ t: 'join', room: 'X'.repeat(40) })).toBeNull();
    expect(validateLobby({ t: 'nope' })).toBeNull();
  });
});

describe('validators — commands', () => {
  it('bounds-checks drill coordinates', () => {
    expect(validateCommand({ t: 'drill', x: 3, y: 4 }, bounds)).toEqual({ t: 'drill', x: 3, y: 4 });
    expect(validateCommand({ t: 'drill', x: -1, y: 0 }, bounds)).toBeNull();
    expect(validateCommand({ t: 'drill', x: 10, y: 0 }, bounds)).toBeNull(); // == cols → out
    expect(validateCommand({ t: 'drill', x: 1.5, y: 0 }, bounds)).toBeNull();
  });

  it('drops out-of-bounds / malformed road cells and caps the count', () => {
    const r = validateCommand({ t: 'roads', cells: [
      { gx: 5, gy: 5, dir: { dx: 1, dy: 0 } },
      { gx: 1e9, gy: 0 },          // out of bounds → dropped
      { gx: 2.2, gy: 1 },          // non-integer → dropped
      { gx: 0, gy: 0, dir: 'bad' },// bad dir → kept, dir nulled
    ] }, bounds);
    expect(r.cells).toEqual([
      { gx: 5, gy: 5, dir: { dx: 1, dy: 0 } },
      { gx: 0, gy: 0, dir: null },
    ]);
    const huge = Array.from({ length: MAX_ROAD_CELLS + 50 }, (_, i) => ({ gx: i % 20, gy: 1 }));
    expect(validateCommand({ t: 'roads', cells: huge }, bounds).cells.length).toBe(MAX_ROAD_CELLS);
    expect(validateCommand({ t: 'roads', cells: 'nope' }, bounds)).toBeNull();
  });

  it('validates a manual control dir or a release', () => {
    expect(validateCommand({ t: 'control', label: 'OHT01', dir: [1, 0] }, bounds))
      .toEqual({ t: 'control', label: 'OHT01', dir: [1, 0] });
    expect(validateCommand({ t: 'control', label: 'OHT01', release: true }, bounds))
      .toEqual({ t: 'control', label: 'OHT01', release: true });
    expect(validateCommand({ t: 'control', label: 'OHT01', dir: [5, 0] }, bounds)).toBeNull();
    expect(validateCommand({ t: 'control', dir: [1, 0] }, bounds)).toBeNull(); // no label
  });

  it('bounds-checks a buyCrusher position', () => {
    expect(validateCommand({ t: 'buyCrusher', gx: 5, gy: 4 }, bounds)).toEqual({ t: 'buyCrusher', gx: 5, gy: 4 });
    expect(validateCommand({ t: 'buyCrusher', gx: 99, gy: 4 }, bounds)).toBeNull();
    expect(validateCommand({ t: 'buyCrusher', gx: 5 }, bounds)).toBeNull();
  });

  it('bounds-checks a move-to target', () => {
    expect(validateCommand({ t: 'moveTo', label: 'OHT01', gx: 5, gy: 4 }, bounds))
      .toEqual({ t: 'moveTo', label: 'OHT01', gx: 5, gy: 4 });
    expect(validateCommand({ t: 'moveTo', label: 'OHT01', gx: 99, gy: 4 }, bounds)).toBeNull();
    expect(validateCommand({ t: 'moveTo', gx: 5, gy: 4 }, bounds)).toBeNull();   // no label
  });

  it('requires strings for label/id/truck and coerces a rect', () => {
    expect(validateCommand({ t: 'assign', truck: 'OHT01', shovel: 'HEX01' }, bounds))
      .toEqual({ t: 'assign', truck: 'OHT01', shovel: 'HEX01' });
    expect(validateCommand({ t: 'assign', truck: 'OHT01' }, bounds))
      .toEqual({ t: 'assign', truck: 'OHT01', shovel: null });
    expect(validateCommand({ t: 'buy', id: 42 }, bounds)).toBeNull();
    expect(validateCommand({ t: 'resizeParking', rect: { x: '3', y: 2, w: 'x', h: 4 } }, bounds))
      .toEqual({ t: 'resizeParking', rect: { x: 3, y: 2, w: 0, h: 4 } });
    expect(validateCommand({ t: 'unknown' }, bounds)).toBeNull();
  });
});
