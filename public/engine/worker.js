// ─────────────────────────────────────────────────────────────────────────────
// Local simulation Web Worker.
//
// In the full-local build there is no server: this worker owns the authoritative
// World, ticks it off the main thread (so rendering stays at 60fps), applies the
// player's commands, and autosaves to IndexedDB. It posts the SAME messages the
// old WebSocket server sent ('state', 'live', 'drilled', 'bought', 'vehicle',
// 'crusher', 'crusherBought', 'roads', 'roadSpend', 'parking', + the binary
// positions frame), so the main-thread LocalEngine dispatches them exactly like
// the old WS client did — the renderer is untouched.
//
// Ported from server/loop.js (adaptive tick) + server/ws-router.js (dispatch).
// ─────────────────────────────────────────────────────────────────────────────
import { World } from '../game/world.js';

const TICK_HZ = 30;          // simulation rate
const NET_EVERY = 2;         // emit deltas every Nth tick (~15 Hz)
const IDLE_EVERY = 6;        // when nothing moves, tick only every Nth frame
const IDLE_ACTIVE_MS = 1500; // a command keeps the sim "active" this long
const AUTOSAVE_MS = 10000;   // write-behind snapshot to IndexedDB
const dt = 1 / TICK_HZ;

let world = null;
const testMode = false;      // matches the old server default (no debug 'P' key)
let lastActivity = 0, skip = 0, tickN = 0, lastDebugStr = '';
let tickTimer = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// ── IndexedDB persistence (fully available inside workers) ──────────────────
const DB_NAME = 'minesim', STORE = 'save', KEY = 'world';
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadSave() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function persist() {
  if (!world) return;
  try {
    const snap = world.snapshotJson();
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(snap, KEY);
  } catch { /* best-effort autosave */ }
}
async function clearSave() {
  try { const db = await openDb(); db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY); }
  catch { /* ignore */ }
}

function sendState() {
  const state = world.fullState();
  state.testMode = testMode;          // enables the local 'P' test-breakdown key
  post({ t: 'state', state });
}

// ── The tick loop (single local world; ported from server/loop.js) ──────────
function stepTick() {
  if (!world) return;
  const now = Date.now();
  const doNet = (++tickN % NET_EVERY === 0);
  // Adaptive tick: while nothing is moving and no command arrived recently, tick
  // at a fraction of the rate (with a matching larger dt) to spare the CPU. Any
  // motion or command instantly returns it to full rate.
  const active = world.anyMoving() || (now - lastActivity < IDLE_ACTIVE_MS);
  if (active) { skip = 0; } else if ((++skip % IDLE_EVERY) !== 0) { return; }
  try {
    world.tick(active ? dt : dt * IDLE_EVERY);
    if (!doNet) return;
    const live = world.liveDelta();
    const posBuf = world.positionsDelta();                 // ArrayBuffer | null
    const debug = world.hasDebug() ? world.debugPaths() : {};
    const debugStr = JSON.stringify(debug);
    const debugChanged = debugStr !== lastDebugStr;
    lastDebugStr = debugStr;
    if (!live && !debugChanged && !posBuf) return;
    if (live || debugChanged) {
      const msg = live ? { t: 'live', ...live } : { t: 'live', vehicles: [], blocks: [] };
      if (debugChanged || Object.keys(debug).length) msg.debug = debug;
      post(msg);
    }
    if (posBuf) post(posBuf, [posBuf]);                    // transfer the buffer
  } catch (err) {
    // Isolate a bad frame — log and keep ticking, exactly like the server did.
    console.error('[engine] tick error (skipped this frame):', err);
  }
}

function startLoops() {
  if (tickTimer) return;
  tickTimer = setInterval(stepTick, 1000 / TICK_HZ);
  setInterval(persist, AUTOSAVE_MS);
}

async function init(load) {
  const saved = load ? await loadSave() : null;
  world = saved ? World.fromSnapshot(typeof saved === 'string' ? JSON.parse(saved) : saved) : new World();
  lastActivity = Date.now();
  post({ t: 'joined', room: 'LOCAL' });
  sendState();
  startLoops();
}

// ── Command dispatch (ported from server/ws-router.js) ──────────────────────
self.onmessage = (e) => {
  const m = e.data;
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'init')  { init(m.load !== false); return; }   // load save unless load:false
  if (m.t === 'save')  { persist(); return; }
  if (!world) return;
  lastActivity = Date.now();
  switch (m.t) {
    case 'drill': {
      const r = world.drill(m.x, m.y);
      post({ t: 'drilled', x: m.x, y: m.y, block: r.block || null, credit: r.credit, error: r.error });
      break;
    }
    case 'roads': {
      const r = world.setRoads(m.cells);
      // Single player: the drawer's optimistic stroke stands; only echo the
      // canonical network back when the budget dropped cells (to correct it).
      if (r.dropped) post({ t: 'roads', cells: world.roads.serialize() });
      if (r.cost > 0) post({ t: 'roadSpend', cost: r.cost, gx: r.gx, gy: r.gy });
      break;
    }
    case 'control': world.control(m.label, { dir: m.dir, release: m.release }); break;
    case 'moveTo':  world.moveTo(m.label, m.gx, m.gy); break;
    case 'assign':  world.assign(m.truck, m.shovel); break;
    case 'debug':   world.setDebug(m.label, m.on); break;
    case 'select':  world.select(m.label, m.on); break;
    case 'buy': {
      const r = world.buyAsset(m.id);
      post({ t: 'bought', id: m.id, ok: r.ok, error: r.error, credit: r.credit, label: r.label });
      if (r.ok) post({ t: 'vehicle', vehicle: r.vehicle });
      break;
    }
    case 'buyCrusher': {
      const r = world.buyCrusher(m.gx, m.gy);
      post({ t: 'crusherBought', ok: r.ok, error: r.error, credit: r.credit, extraCrushers: r.extraCrushers });
      if (r.ok) post({ t: 'crusher', crusher: r.crusher, extraCrushers: r.extraCrushers });
      break;
    }
    case 'reset':
      world.reset();
      clearSave();
      sendState();
      break;
    case 'breakdown':
      world.testBreakdown?.();   // local sandbox: always allowed
      break;
    case 'resizeParking': {
      const rect = world.resizeParking(m.rect);
      post({ t: 'parking', rect, cells: world.roads.serialize() });
      break;
    }
  }
};
