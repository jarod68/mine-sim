// Inbound WebSocket message validation. Every message is checked and sanitized
// here BEFORE it can touch a World: types are enforced, strings are length-capped,
// and coordinates/arrays are bounds-capped so a hostile client can never grow
// server state without limit (e.g. millions of out-of-range road cells).
//
// Each validator returns a sanitized message object, or null to reject.

const MAX_ROAD_CELLS = 20000;   // hard cap on a single `roads` payload
const MAX_STR = 24;             // label / id / room-code length cap

const isInt = (n) => Number.isInteger(n);
const isStr = (s, max = MAX_STR) => typeof s === 'string' && s.length > 0 && s.length <= max;
const unit = (n) => n === -1 || n === 0 || n === 1;

// Lobby messages need no room/bounds.
function validateLobby(m) {
  if (m.t === 'create') return { t: 'create' };
  if (m.t === 'join') return isStr(m.room) ? { t: 'join', room: m.room } : null;
  return null;
}

// Room-scoped commands. `bounds` = { cols, rows, zoneCols, zoneRows } from the
// room's world (block grid + sub-zone grid).
function validateCommand(m, bounds) {
  switch (m.t) {
    case 'drill':
      return isInt(m.x) && isInt(m.y) && inRange(m.x, bounds.cols) && inRange(m.y, bounds.rows)
        ? { t: 'drill', x: m.x, y: m.y } : null;

    case 'roads':
      return validateRoads(m.cells, bounds);

    case 'control': {
      if (!isStr(m.label)) return null;
      if (m.release) return { t: 'control', label: m.label, release: true };
      const dir = validateDir(m.dir);
      return dir === undefined ? null : { t: 'control', label: m.label, dir };
    }

    case 'assign':
      return isStr(m.truck)
        ? { t: 'assign', truck: m.truck, shovel: isStr(m.shovel) ? m.shovel : null } : null;

    case 'moveTo':
      return isStr(m.label) && isInt(m.gx) && isInt(m.gy)
        && inRange(m.gx, bounds.zoneCols) && inRange(m.gy, bounds.zoneRows)
        ? { t: 'moveTo', label: m.label, gx: m.gx, gy: m.gy } : null;

    case 'debug':
      return isStr(m.label) ? { t: 'debug', label: m.label, on: !!m.on } : null;

    case 'select':
      return isStr(m.label) ? { t: 'select', label: m.label, on: !!m.on } : null;

    case 'buy':
      return isStr(m.id) ? { t: 'buy', id: m.id } : null;

    case 'reset':
      return { t: 'reset' };

    case 'resizeParking':
      return m.rect && typeof m.rect === 'object'
        ? { t: 'resizeParking', rect: validateRect(m.rect) } : null;

    default:
      return null;
  }
}

function inRange(v, max) { return v >= 0 && v < max; }

// A manual-drive direction (control): an array of two values in {-1,0,1}, or
// null/absent. Returns the cleaned dir, or `undefined` to signal "invalid".
function validateDir(dir) {
  if (dir == null) return null;
  if (!Array.isArray(dir) || dir.length !== 2 || !unit(dir[0]) || !unit(dir[1])) return undefined;
  return [dir[0], dir[1]];
}

// A road-flow direction is an object { dx, dy } with unit components; anything
// else becomes null (an undirected cell), never a reject.
function validateRoadDir(dir) {
  if (dir && typeof dir === 'object' && unit(dir.dx) && unit(dir.dy)) return { dx: dir.dx, dy: dir.dy };
  return null;
}

// Keep only well-formed, in-bounds road cells, capped in count.
function validateRoads(cells, bounds) {
  if (!Array.isArray(cells)) return null;
  const out = [];
  for (const c of cells) {
    if (out.length >= MAX_ROAD_CELLS) break;
    if (!c || !isInt(c.gx) || !isInt(c.gy)) continue;
    if (!inRange(c.gx, bounds.zoneCols) || !inRange(c.gy, bounds.zoneRows)) continue;
    out.push({ gx: c.gx, gy: c.gy, dir: validateRoadDir(c.dir) });
  }
  return { t: 'roads', cells: out };
}

// Coerce a parking rect to finite numbers; World.resizeParking clamps the rest.
function validateRect(r) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) };
}

module.exports = { validateLobby, validateCommand, validateRoads, validateRect, validateDir, MAX_ROAD_CELLS, MAX_STR };
