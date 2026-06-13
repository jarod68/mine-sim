import { GameCanvas, VIEW_W, VIEW_H } from './components/game-canvas.js';
import { BlockPopup } from './components/block-popup.js';
import { Fleet, Vehicle } from './components/vehicle.js';
import { Roads } from './components/roads.js';
import { Autopilot } from './components/auto.js';
import { camera, toWorld } from './components/camera.js';
import { COLORS_SOLID } from './components/mine.js';

const canvas = document.getElementById('mine');
const creditEl = document.getElementById('credit');
const assetEl = document.getElementById('asset-details');
const popup = new BlockPopup(document.getElementById('popup'));

// Paint the legend swatches from the single source of truth (COLORS).
function paintLegend() {
  for (const sw of document.querySelectorAll('.legend .sw')) {
    const ore = sw.dataset.ore;
    if (ore && COLORS_SOLID[ore]) {
      sw.style.background = COLORS_SOLID[ore];
      sw.style.boxShadow = `0 0 6px ${COLORS_SOLID[ore]}`; // phosphor glow
    }
  }
}

let game;
let fleet;
let roads;
let autopilot;
let drillCost = 5000;
let blockW = 0;
let blockH = 0;

function setupModes() {
  const btns = {
    mouse: document.getElementById('mode-mouse'),
    road: document.getElementById('mode-road'),
    erase: document.getElementById('mode-erase'),
  };
  const tool = { mouse: 'none', road: 'draw', erase: 'erase' };

  const setMode = (mode) => {
    roads.setTool(tool[mode]);
    for (const [m, btn] of Object.entries(btns)) btn.classList.toggle('active', m === mode);
  };

  for (const [mode, btn] of Object.entries(btns)) btn.addEventListener('click', () => setMode(mode));
  document.getElementById('invert-dir').addEventListener('click', () => roads.invert());

  setMode('mouse');
}

function setCredit(c) {
  if (typeof c === 'number') creditEl.textContent = `$${c.toLocaleString('en-US')}`;
}

async function getState() {
  const res = await fetch('/api/state');
  return res.json();
}

// Drill is authoritative on the server: it charges the credit and returns the
// revealed block (or 402 if the player can't afford it).
async function drill(block) {
  const res = await fetch('/api/drill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: block.x, y: block.y }),
  });
  const body = await res.json().catch(() => ({}));
  setCredit(body.credit);
  if (res.ok && body.block) {
    game.updateBlock(body.block);
    return body.block;
  }
  return null;
}

const onBlockClick = (block, pos) => {
  // selection outline is drawn on the vehicle layer (above the roads)
  fleet.selectionRect = { x: block.x * blockW, y: block.y * blockH, w: blockW, h: blockH };
  popup.show(block, pos, { onDrill: drill, drillCost });
};

async function init() {
  paintLegend();
  const state = await getState();
  drillCost = state.drillCost;
  setCredit(state.credit);
  game = new GameCanvas(canvas, state, onBlockClick);
  blockW = VIEW_W / state.cols;
  blockH = VIEW_H / state.rows;

  // Sub-zone grid: each mining block is split into 2 × 2 cells.
  const zoneCols = state.cols * 2;
  const zoneRows = state.rows * 2;
  const grid = {
    zoneCols,
    zoneRows,
    zoneW: VIEW_W / zoneCols,
    zoneH: VIEW_H / zoneRows,
  };
  const zone = Math.min(grid.zoneW, grid.zoneH);

  // Road editor (drawn between the grid and the vehicles). The parking pad and
  // crusher come from the server, so they stay fixed across page refreshes.
  roads = new Roads(document.getElementById('roads-layer'), { w: VIEW_W, h: VIEW_H }, grid);
  const PARK = state.parking;
  roads.addParking(PARK.x, PARK.y, PARK.w, PARK.h);
  roads.setCrusher(state.crusher.x, state.crusher.y, state.crusher.w, state.crusher.h);
  // Restore the persisted road network and save back to the server on every edit.
  if (state.roads) roads.load(state.roads);
  roads.onChange = scheduleRoadsSave;

  fleet = new Fleet(document.getElementById('vehicle-layer'), { w: VIEW_W, h: VIEW_H }, grid);
  fleet.setRoads(roads);
  fleet.add(new Vehicle({
    type: 'pickup', label: 'LV01', gx: 6, gy: 8,
    len: zone * 0.95, wid: zone * 0.95 * 0.6,
  }));
  const shovel = new Vehicle({
    type: 'excavator', label: 'HEX01', gx: 12, gy: 12,
    len: zone * 1.2, wid: zone * 0.95,
  });
  const shovel2 = new Vehicle({
    type: 'excavator', label: 'HEX02', gx: 20, gy: 16,
    len: zone * 1.2, wid: zone * 0.95,
  });
  fleet.add(shovel);
  fleet.add(shovel2);

  const mkOHT = (label, gx, gy) => new Vehicle({
    type: 'oht', label, gx, gy, len: zone * 1.7, wid: zone * 0.7,
  });
  const oht1 = mkOHT('OHT01', PARK.x + 1, PARK.y);
  const oht2 = mkOHT('OHT02', PARK.x + 3, PARK.y);
  const oht3 = mkOHT('OHT03', PARK.x + 5, PARK.y);
  const oht4 = mkOHT('OHT04', PARK.x + 1, PARK.y + 1);
  fleet.add(oht1);
  fleet.add(oht2);
  fleet.add(oht3);
  fleet.add(oht4);

  // Autopilot is the natural, always-on behaviour. Both shovels work in
  // parallel; trucks are assigned two per shovel and can be re-assigned to
  // either shovel from the Asset details panel.
  autopilot = new Autopilot(grid, roads, {
    getBlock: (bx, by) => game.mine.blocks[by]?.[bx],
    mineBlock,
    deliver,
  });
  fleet.setAutopilot(autopilot);
  autopilot.addShovel(shovel);
  autopilot.addShovel(shovel2);
  autopilot.assign(oht1, shovel);
  autopilot.assign(oht2, shovel);
  autopilot.assign(oht3, shovel2);
  autopilot.assign(oht4, shovel2);
  autopilot.setEnabled(true);

  // Vehicles always start parked (initial placement above). Their live positions
  // are streamed to the server continuously, plus a reliable beacon save when
  // the tab is hidden or closed — positions are persisted at all times.
  setInterval(saveVehicles, 300);
  window.addEventListener('pagehide', beaconVehicles);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) beaconVehicles();
  });

  setupModes();
  renderAsset(null);

  // Clicking a vehicle selects it and shows its details (no drill). Capture
  // phase runs before the GameCanvas handler; stopPropagation skips drilling.
  // Coordinates are mapped through the canvas rect so they work under zoom/pan.
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const w = toWorld(e.clientX, e.clientY, rect);
    const v = fleet.selectAt(w.x, w.y);
    if (v) {
      e.stopPropagation();
      renderAsset(v);
    }
  }, true);

  setupCamera();
}

// ── Camera: scroll to zoom (re-renders crisply), right-drag to pan ──
function setupCamera() {
  const stage = document.querySelector('main');

  const rerender = () => { game.render(); roads.render(); }; // fleet auto-renders
  const resizeAll = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    game.resize(w, h);
    roads.resize(w, h);
    fleet.resize(w, h);
  };
  const minScale = () =>
    Math.min(stage.clientWidth / VIEW_W, stage.clientHeight / VIEW_H) * 0.5;
  const fit = () => {
    const s = Math.min(stage.clientWidth / VIEW_W, stage.clientHeight / VIEW_H);
    camera.scale = s;
    camera.ox = (stage.clientWidth - VIEW_W * s) / 2;
    camera.oy = (stage.clientHeight - VIEW_H * s) / 2;
    rerender();
  };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const ns = Math.max(minScale(), Math.min(6, camera.scale * factor));
    camera.ox = mx - ((mx - camera.ox) * ns) / camera.scale;
    camera.oy = my - ((my - camera.oy) * ns) / camera.scale;
    camera.scale = ns;
    rerender();
  }, { passive: false });

  let panning = false;
  let px = 0;
  let py = 0;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    panning = true;
    px = e.clientX;
    py = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    camera.ox += e.clientX - px;
    camera.oy += e.clientY - py;
    px = e.clientX;
    py = e.clientY;
    rerender();
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 2) panning = false; });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', () => { resizeAll(); fit(); });

  resizeAll();
  fit();
}

async function mineBlock(bx, by, amount) {
  const res = await fetch('/api/mine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: bx, y: by, amount }),
  });
  if (!res.ok) return 0;
  const data = await res.json();
  game.updateBlock(data.block);
  return data.mined;
}

// Truck dumped at the crusher → get paid for the ore delivered.
async function deliver(ore, tons) {
  if (!ore || tons <= 0) return;
  const res = await fetch('/api/deliver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ore, tons }),
  });
  if (!res.ok) return;
  const data = await res.json();
  setCredit(data.credit);
}

// ── Server-side persistence: roads & live vehicle positions ──

let roadsSaveTimer = null;
function scheduleRoadsSave() {
  clearTimeout(roadsSaveTimer);
  roadsSaveTimer = setTimeout(saveRoads, 400); // debounce rapid edits
}

async function saveRoads() {
  try {
    await fetch('/api/roads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cells: roads.serialize() }),
    });
  } catch { /* offline — keep playing, retry on next edit */ }
}

function vehicleSnapshot() {
  const out = {};
  for (const v of fleet.vehicles) {
    out[v.label] = {
      gx: v.gx, gy: v.gy, x: v.x, y: v.y,
      heading: v.heading, load: v.load, loadOre: v.loadOre, type: v.type,
    };
  }
  return out;
}

async function saveVehicles() {
  if (!fleet) return;
  try {
    await fetch('/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vehicles: vehicleSnapshot() }),
    });
  } catch { /* offline — next tick retries */ }
}

// Reliable save on tab hide / close (fetch may be cancelled during unload).
function beaconVehicles() {
  if (!fleet || !navigator.sendBeacon) return;
  try {
    const body = new Blob([JSON.stringify({ vehicles: vehicleSnapshot() })],
      { type: 'application/json' });
    navigator.sendBeacon('/api/vehicles', body);
  } catch { /* ignore */ }
}

// ── Asset details panel (top-left) ──
function renderAsset(v) {
  if (!v) {
    assetEl.innerHTML = '<h2>Asset details</h2><p class="muted">No asset selected</p>';
    return;
  }

  let rows = `
    <div class="arow"><span>Model</span><b>${v.model}</b></div>
    <div class="arow"><span>Name</span><b>${v.label}</b></div>`;

  if (v.type === 'oht') {
    const shovels = fleet.vehicles.filter((x) => x.type === 'excavator');
    const current = autopilot.assignedShovel(v);
    const options = ['<option value="">— none —</option>']
      .concat(shovels.map((s) =>
        `<option value="${s.label}"${s === current ? ' selected' : ''}>${s.label}</option>`))
      .join('');
    rows += `
      <div class="arow"><span>Payload</span><b>${v.payload} t</b></div>
      <div class="arow"><span>Carrying</span><b>${Math.round(v.load)} t</b></div>
      <div class="arow"><span>Shovel</span><select id="asset-shovel">${options}</select></div>`;
  } else if (v.type === 'excavator') {
    const trucks = fleet.vehicles
      .filter((x) => x.type === 'oht' && autopilot.assignedShovel(x) === v)
      .map((x) => x.label);
    rows += `
      <div class="arow"><span>Bucket</span><b>${v.bucket} t</b></div>
      <div class="arow"><span>Trucks</span><b>${trucks.join(', ') || '—'}</b></div>`;
  }

  assetEl.innerHTML = `<h2>Asset details</h2>${rows}`;

  const sel = assetEl.querySelector('#asset-shovel');
  if (sel) {
    sel.addEventListener('change', (e) => {
      const shovel = fleet.vehicles.find((x) => x.label === e.target.value) || null;
      autopilot.assign(v, shovel);
      renderAsset(v);
    });
  }
}

document.getElementById('regen').addEventListener('click', async () => {
  popup.hide();
  const res = await fetch('/api/reset', { method: 'POST' });
  const state = await res.json();
  drillCost = state.drillCost;
  setCredit(state.credit);
  game.setMine(state);
  roads.clear();   // fresh mine ⇒ wipe the road network (also clears on server)
  const PARK = state.parking;
  roads.addParking(PARK.x, PARK.y, PARK.w, PARK.h);
  roads.setCrusher(state.crusher.x, state.crusher.y, state.crusher.w, state.crusher.h);
});

init();
