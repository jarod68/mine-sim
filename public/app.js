// Thin client: renders authoritative server snapshots and sends commands over a
// single WebSocket (no HTTP polling). The server owns the entire simulation.

import { GameCanvas } from './components/game-canvas.js';
import { BlockPopup } from './components/block-popup.js';
import { Fleet } from './components/vehicle.js';
import { Roads } from './components/roads.js';
import { camera, toWorld } from './components/camera.js';
import { COLORS_SOLID } from './components/mine.js';
import { Net } from './components/net.js';

const canvas = document.getElementById('mine');
const creditEl = document.getElementById('credit');
const assetEl = document.getElementById('asset-details');
const popup = new BlockPopup(document.getElementById('popup'));
const shopEl = document.getElementById('shop');
let setMode = () => {};   // assigned by setupModes(); lets other code switch tool mode

const net = new Net();
let game;
let fleet;
let roads;
let drillCost = 5000;
let blockW = 0;
let blockH = 0;
let built = false;
let creditValue = 0;
let catalog = [];
let maxAssets = 150;
let crusherPrice = 1000000;
let extraCrushers = 0;
let maxExtraCrushers = 5;
let viewW = 0, viewH = 0;    // world-space dims, from the server's state.view
let grid = null;             // sub-zone grid metrics (set in build)
let parkRect = null;         // current parking pad rect (sub-zones)
let selectedBlock = null;    // last clicked block (target of the "X" drill shortcut)
let selectedBlockPos = null;
const debugOn = new Set();   // asset labels with debug-path view enabled
let selectedShovelLabel = null;

// Tell the server which shovel is selected — a selected shovel pauses its
// automatic relocation until deselected.
function syncSelection(v) {
  const next = v && v.type === 'excavator' ? v.label : null;
  if (selectedShovelLabel && selectedShovelLabel !== next) net.select(selectedShovelLabel, false);
  if (next && next !== selectedShovelLabel) net.select(next, true);
  selectedShovelLabel = next;
}

// The server sends only significant blocks (explored / veins); rebuild the full
// grid here, defaulting every other cell to unexplored.
function hydrateBlocks(state) {
  if (!Array.isArray(state.blocks) || Array.isArray(state.blocks[0])) return; // already a grid
  const grid = [];
  for (let y = 0; y < state.rows; y++) {
    const row = [];
    for (let x = 0; x < state.cols; x++) row.push({ x, y, explored: false });
    grid.push(row);
  }
  for (const b of state.blocks) grid[b.y][b.x] = b;
  state.blocks = grid;
}

net.onState = (state) => { hydrateBlocks(state); built ? refresh(state) : build(state); };
net.onLive = (data) => onLive(data);
net.onPositions = (recs) => { if (fleet) fleet.applyPositions(recs); };
net.onRoads = (cells) => { if (roads) roads.setNetwork(cells); };
net.onParking = (rect, cells) => {     // another client resized the parking pad
  if (!roads) return;
  parkRect = { ...rect };
  roads.setParking(rect);
  roads.setNetwork(cells);
  updateParkOverlay();
  invalidateAll();
};
net.onVehicle = (v) => {           // a newly bought asset (no full-state reload)
  if (!fleet || !v) return;
  fleet.sync([v]);
  if (!shopEl.hidden) renderShop();
};
net.onCrusher = (crusher, extra) => {   // a freshly placed crusher
  if (!roads) return;
  roads.addCrusher(crusher);
  if (typeof extra === 'number') extraCrushers = extra;
  invalidateRoads();
  if (!shopEl.hidden) renderShop();
};

// ── render scheduler ──
// The mine and roads layers are static between edits, so they must NOT redraw on
// every block delta (≤15 Hz) or every pan/zoom event. Instead we mark layers
// dirty and flush at most once per animation frame. (The vehicle layer animates
// continuously on its own rAF for smooth lerping.)
let mineDirty = false;
let roadsDirty = false;
let framePending = false;
function flushFrame() {
  framePending = false;
  if (mineDirty && game) { game.render(); mineDirty = false; }
  if (roadsDirty && roads) { roads.render(); roadsDirty = false; }
  updateParkOverlay();   // keep the resize handles pinned to the pad as the view moves
}
function scheduleFrame() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(flushFrame);
}
function invalidateMine() { mineDirty = true; scheduleFrame(); }
function invalidateRoads() { roadsDirty = true; scheduleFrame(); }
function invalidateAll() { mineDirty = roadsDirty = true; scheduleFrame(); }

// ── helpers ──
function paintLegend() {
  for (const sw of document.querySelectorAll('.legend .sw')) {
    const ore = sw.dataset.ore;
    if (ore && COLORS_SOLID[ore]) {
      sw.style.background = COLORS_SOLID[ore];
      sw.style.boxShadow = `0 0 6px ${COLORS_SOLID[ore]}`;
    }
  }
}

function setCredit(c) {
  if (typeof c !== 'number') return;
  creditValue = c;
  creditEl.textContent = `$${c.toLocaleString('en-US')}`;
  if (!shopEl.hidden) renderShop();   // keep the open shop in sync
}

function setupModes() {
  const btns = {
    mouse: document.getElementById('mode-mouse'),
    road: document.getElementById('mode-road'),
    erase: document.getElementById('mode-erase'),
  };
  const tool = { mouse: 'none', road: 'draw', erase: 'erase' };
  setMode = (mode) => {
    roads.setTool(tool[mode]);
    if (mode !== 'mouse') closeParkResize();   // resize handles only live in Mouse mode
    for (const [m, btn] of Object.entries(btns)) btn.classList.toggle('active', m === mode);
  };
  for (const [mode, btn] of Object.entries(btns)) btn.addEventListener('click', () => setMode(mode));
  setMode('mouse');
}

// Drill is authoritative: the server reveals the block and replies with it.
async function drill(block) {
  const r = await net.drill(block.x, block.y);
  if (!r) return null;
  setCredit(r.credit);
  if (r.block) { game.updateBlock(r.block); return r.block; }
  return null;
}

const onBlockClick = (block, pos) => {
  fleet.selectionRect = { x: block.x * blockW, y: block.y * blockH, w: blockW, h: blockH };
  selectedBlock = block;
  selectedBlockPos = pos;
  popup.show(block, pos, { onDrill: drill, drillCost });
};

// "X" drills the currently selected (highlighted) block, same as the popup button.
async function drillSelectedBlock() {
  const b = selectedBlock;
  if (!b || b.explored) return;
  const wasOpen = popup.el.style.display === 'block';
  const revealed = await drill(b);
  if (revealed) {
    selectedBlock = revealed;
    if (wasOpen && selectedBlockPos) popup.show(revealed, selectedBlockPos, { onDrill: drill, drillCost });
  }
}

let roadsSaveTimer = null;
function scheduleRoadsSave() {
  clearTimeout(roadsSaveTimer);
  roadsSaveTimer = setTimeout(() => { roadsSaveTimer = null; net.roads(roads.serialize()); }, 250);
}
// Send a pending road edit right now (used before a server state could clobber it).
function flushRoadsSave() {
  if (!roadsSaveTimer) return;
  clearTimeout(roadsSaveTimer);
  roadsSaveTimer = null;
  net.roads(roads.serialize());
}

// ── first full state → build everything once ──
function build(state) {
  built = true;
  paintLegend();
  drillCost = state.drillCost;
  catalog = state.catalog || [];
  maxAssets = state.maxAssets || 150;
  if (state.crusherPrice) crusherPrice = state.crusherPrice;
  if (typeof state.extraCrushers === 'number') extraCrushers = state.extraCrushers;
  if (state.maxExtraCrushers) maxExtraCrushers = state.maxExtraCrushers;
  setCredit(state.credit);
  viewW = state.view.w; viewH = state.view.h;
  game = new GameCanvas(canvas, state, onBlockClick);
  blockW = viewW / state.cols;
  blockH = viewH / state.rows;

  const zoneCols = state.cols * 2;
  const zoneRows = state.rows * 2;
  grid = { zoneCols, zoneRows, zoneW: viewW / zoneCols, zoneH: viewH / zoneRows };

  roads = new Roads(document.getElementById('roads-layer'), { w: viewW, h: viewH }, grid);
  parkRect = { ...state.parking };
  roads.addParking(parkRect.x, parkRect.y, parkRect.w, parkRect.h);
  roads.setCrushers(state.crushers);
  if (state.roads) roads.load(state.roads);
  roads.onChange = scheduleRoadsSave;
  // Block road drawing over an un-prepared dozer vein (server enforces it too).
  roads.isVeinBlocked = (gx, gy) => {
    const b = game.mine.blocks[Math.floor(gy / 2)]?.[Math.floor(gx / 2)];
    return !!(b && b.prep && !b.explored);
  };
  roads.onRender = invalidateRoads;   // coalesce edit/pan redraws into the shared frame
  roads.onPan = () => { invalidateAll(); updateParkOverlay(); };   // edge auto-pan → redraw all

  fleet = new Fleet(document.getElementById('vehicle-layer'), { w: viewW, h: viewH }, grid);
  fleet.onControl = (label, cmd) => net.control(label, cmd);
  fleet.onSelect = (v) => { syncSelection(v); renderAsset(v); };
  fleet.sync(state.vehicles);
  fleet.snapToTargets();

  setupModes();
  renderAsset(null);

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const w = toWorld(e.clientX, e.clientY, rect);
    // "Move to point": the next click after pressing W / the asset button picks
    // the destination for the selected vehicle.
    if (moveMode) {
      const sel = fleet.selected;
      if (sel && grid) {
        const gx = Math.max(0, Math.min(grid.zoneCols - 1, Math.floor(w.x / grid.zoneW)));
        const gy = Math.max(0, Math.min(grid.zoneRows - 1, Math.floor(w.y / grid.zoneH)));
        net.moveTo(sel.label, gx, gy);
        fleet.setMoveMarker(sel.label, w.x, w.y);
      }
      exitMoveMode();
      e.stopPropagation();
      return;
    }
    // Crusher placement: the next click after buying one positions it.
    if (crusherPlaceMode) {
      if (grid) {
        const gx = Math.max(0, Math.min(grid.zoneCols - 2, Math.floor(w.x / grid.zoneW)));
        const gy = Math.max(0, Math.min(grid.zoneRows - 2, Math.floor(w.y / grid.zoneH)));
        net.buyCrusher(gx, gy).then((r) => { if (r && r.ok) setCredit(r.credit); });
      }
      exitCrusherPlace();
      e.stopPropagation();
      return;
    }
    const v = fleet.selectAt(w.x, w.y);
    if (v) { e.stopPropagation(); popup.hide(); closeParkResize(); selectedBlock = null; return; }   // selecting an asset closes the drill popup
    fleet.setSelected(null);
    // In Mouse mode, clicking the parking pad opens its resize handles instead of
    // drilling the block underneath.
    if (roads.tool === 'none' && roads.pointInParking(w.x, w.y)) {
      e.stopPropagation();
      selectedBlock = null;
      openParkResize();
      return;
    }
    closeParkResize();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'x' && e.key !== 'X') return;
    if (e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    drillSelectedBlock();
  });

  setupParkOverlay();
  setupCamera();
}

// ── subsequent full state (after reset or a purchase) → refresh data ──
function refresh(state) {
  drillCost = state.drillCost;
  catalog = state.catalog || catalog;
  maxAssets = state.maxAssets || maxAssets;
  if (typeof state.extraCrushers === 'number') extraCrushers = state.extraCrushers;
  game.setMine(state);
  roads.setCrushers(state.crushers);
  // Reload the server's road network WITHOUT firing onChange. But if we have a
  // local road edit not yet confirmed, keep ours and push it instead — a
  // server state must never clobber an in-progress drawing.
  if (roadsSaveTimer) flushRoadsSave();
  else roads.setNetwork(state.roads || []);
  if (state.parking) { parkRect = { ...state.parking }; roads.setParking(parkRect); updateParkOverlay(); }
  fleet.sync(state.vehicles);
  setCredit(state.credit);   // last → refreshes the open shop with the new count
  fleet.snapToTargets();
}

// ── Parking resize overlay (drag handles on the pad's four sides) ──
let parkOverlay = null;
const parkHandles = {};      // side → handle element
let parkLabel = null;
let parkDrag = null;         // { side } while a handle is being dragged
let parkOpen = false;

function setupParkOverlay() {
  const stage = document.querySelector('main');
  parkOverlay = document.createElement('div');
  parkOverlay.className = 'park-overlay';
  parkOverlay.hidden = true;
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const h = document.createElement('div');
    h.className = `park-handle park-${side}`;
    h.addEventListener('pointerdown', (e) => startParkDrag(e, side));
    parkOverlay.appendChild(h);
    parkHandles[side] = h;
  }
  parkLabel = document.createElement('div');
  parkLabel.className = 'park-label';
  parkOverlay.appendChild(parkLabel);
  stage.appendChild(parkOverlay);
  window.addEventListener('pointermove', onParkDrag);
  window.addEventListener('pointerup', endParkDrag);
}

function openParkResize() {
  if (!parkOverlay || !parkRect) return;
  parkOpen = true;
  parkOverlay.hidden = false;
  updateParkOverlay();
}
function closeParkResize() {
  if (!parkOpen) return;
  parkOpen = false;
  parkDrag = null;
  if (parkOverlay) parkOverlay.hidden = true;
}

// World (logical) point → stage (CSS px) using the live camera transform.
function worldToStage(wx, wy) {
  return { x: wx * camera.scale + camera.ox, y: wy * camera.scale + camera.oy };
}

function updateParkOverlay() {
  if (!parkOpen || !parkRect || !grid) return;
  const zw = grid.zoneW, zh = grid.zoneH;
  const x0 = parkRect.x * zw, y0 = parkRect.y * zh;
  const x1 = (parkRect.x + parkRect.w) * zw, y1 = (parkRect.y + parkRect.h) * zh;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const place = (el, wx, wy) => { const p = worldToStage(wx, wy); el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; };
  place(parkHandles.left, x0, cy);
  place(parkHandles.right, x1, cy);
  place(parkHandles.top, cx, y0);
  place(parkHandles.bottom, cx, y1);
  place(parkLabel, x0, y0);
  parkLabel.textContent = `Parking ${parkRect.w}×${parkRect.h}`;
}

function startParkDrag(e, side) {
  e.preventDefault();
  e.stopPropagation();
  parkDrag = { side };
  e.target.setPointerCapture?.(e.pointerId);
}

function onParkDrag(e) {
  if (!parkDrag || !parkRect || !grid) return;
  const rect = canvas.getBoundingClientRect();
  const w = toWorld(e.clientX, e.clientY, rect);
  const gx = Math.round(w.x / grid.zoneW);
  const gy = Math.round(w.y / grid.zoneH);
  const r = { ...parkRect };
  const MIN = 2;
  if (parkDrag.side === 'right') r.w = Math.max(MIN, Math.min(grid.zoneCols - r.x, gx - r.x));
  else if (parkDrag.side === 'bottom') r.h = Math.max(MIN, Math.min(grid.zoneRows - r.y, gy - r.y));
  else if (parkDrag.side === 'left') { const right = r.x + r.w; const nx = Math.max(0, Math.min(right - MIN, gx)); r.x = nx; r.w = right - nx; }
  else if (parkDrag.side === 'top') { const bottom = r.y + r.h; const ny = Math.max(0, Math.min(bottom - MIN, gy)); r.y = ny; r.h = bottom - ny; }
  parkRect = r;
  roads.setParking(parkRect);   // live preview (re-renders the roads layer)
  invalidateRoads();
  updateParkOverlay();
}

function endParkDrag() {
  if (!parkDrag) return;
  parkDrag = null;
  net.resizeParking(parkRect);   // commit → server trims roads and broadcasts the authoritative pad
}

// ── live delta updates (≤ 15 Hz, only what changed) ──
function onLive(data) {
  if (typeof data.credit === 'number') setCredit(data.credit);
  if (!fleet) return;
  if (data.vehicles && data.vehicles.length) fleet.applyDeltas(data.vehicles);
  if (data.blocks && data.blocks.length) {
    for (const b of data.blocks) game.mine.blocks[b.y][b.x] = b;
    invalidateMine();   // redraw at most once next frame, not synchronously per delta
  }
  if ('debug' in data) fleet.debugPaths = data.debug;
  if (data.payouts) for (const p of data.payouts) fleet.addPayout(p.gx, p.gy, p.amount);
  updateAssetLive();
}

// ── Camera: scroll to zoom, right-drag to pan ──
function setupCamera() {
  const stage = document.querySelector('main');
  const rerender = invalidateAll;   // coalesced: redraw mine + roads once next frame
  const resizeAll = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    game.resize(w, h);
    roads.resize(w, h);
    fleet.resize(w, h);
  };
  const minScale = () => Math.min(stage.clientWidth / viewW, stage.clientHeight / viewH) * 0.5;
  const fit = () => {
    const s = Math.min(stage.clientWidth / viewW, stage.clientHeight / viewH);
    camera.scale = s;
    camera.ox = (stage.clientWidth - viewW * s) / 2;
    camera.oy = (stage.clientHeight - viewH * s) / 2;
    rerender();
  };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    popup.hide();   // close any open popup when the view moves
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

  let panning = false, px = 0, py = 0;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    popup.hide();   // close any open popup when panning the map
    panning = true; px = e.clientX; py = e.clientY; e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    camera.ox += e.clientX - px; camera.oy += e.clientY - py;
    px = e.clientX; py = e.clientY;
    rerender();
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 2) panning = false; });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('resize', () => { resizeAll(); fit(); });

  resizeAll();
  fit();
}

// ── Asset details panel (top-left) — compact, fields side by side ──
function renderAsset(v) {
  if (!v) {
    assetEl.innerHTML = '<span class="atitle">Asset</span><span class="muted">No asset selected</span>';
    return;
  }

  const item = (label, val) => `<span class="ai"><i>${label}</i><b>${val}</b></span>`;
  const parts = [item('Model', v.model), item('Name', v.label)];

  if (v.type === 'oht') {
    const shovels = fleet.vehicles.filter((x) => x.type === 'excavator');
    const options = ['<option value="">—</option>']
      .concat(shovels.map((s) =>
        `<option value="${s.label}"${s.label === v.shovel ? ' selected' : ''}>${s.label}</option>`))
      .join('');
    parts.push(item('Payload', `${v.payload} t`));
    parts.push(`<span class="ai"><i>Carrying</i><b id="asset-carry">${Math.round(v.load)} t</b></span>`);
    parts.push(`<span class="ai"><i>Shovel</i><select id="asset-shovel">${options}</select></span>`);
  } else if (v.type === 'excavator') {
    const trucks = fleet.vehicles.filter((x) => x.type === 'oht' && x.shovel === v.label).map((x) => x.label);
    parts.push(item('Bucket', `${v.bucket} t`));
    parts.push(`<span class="ai"><i>Trucks</i><b id="asset-trucks">${trucks.join(', ') || '—'}</b></span>`);
  }

  parts.push(`<span class="ai"><i>Debug</i><input type="checkbox" id="asset-debug"${debugOn.has(v.label) ? ' checked' : ''}></span>`);
  parts.push('<button id="asset-moveto" class="asset-btn" title="Then click a destination on the map (shortcut: W)">🎯 Move to…</button>');

  assetEl.innerHTML = `<span class="atitle">Asset</span>${parts.join('')}`;

  const sel = assetEl.querySelector('#asset-shovel');
  if (sel) {
    sel.addEventListener('change', (e) => net.assign(v.label, e.target.value || null));
  }

  const mv = assetEl.querySelector('#asset-moveto');
  if (mv) {
    mv.addEventListener('click', () => (moveMode ? exitMoveMode() : enterMoveMode()));
    if (moveMode) markMoveButton(true);   // keep the button state when the panel rebuilds
  }

  const dbg = assetEl.querySelector('#asset-debug');
  if (dbg) {
    dbg.addEventListener('change', (e) => {
      const on = e.target.checked;
      if (on) debugOn.add(v.label);
      else { debugOn.delete(v.label); if (fleet.debugPaths) delete fleet.debugPaths[v.label]; }
      net.debug(v.label, on);
    });
  }
}

// ── "Move to point" mode ──
// Press W (or the asset button) with a vehicle selected, then click a destination
// on the map; the server routes the vehicle there via the shortest path (on roads,
// off-road where needed).
let moveMode = false;
function markMoveButton(on) {
  const b = assetEl.querySelector('#asset-moveto');
  if (!b) return;
  b.textContent = on ? '🎯 Click a destination…' : '🎯 Move to…';
  b.classList.toggle('active', on);
}
function enterMoveMode() {
  if (!fleet || !fleet.selected) return;
  moveMode = true;
  canvas.style.cursor = 'cell';
  markMoveButton(true);
}
function exitMoveMode() {
  if (!moveMode) return;
  moveMode = false;
  canvas.style.cursor = '';
  markMoveButton(false);
}
window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === 'w' || e.key === 'W') moveMode ? exitMoveMode() : enterMoveMode();
  else if (e.key === 'Escape') { exitMoveMode(); exitCrusherPlace(); }
});

// ── Crusher placement mode ──
// Buying a crusher from the shop arms this; the next map click places it.
let crusherPlaceMode = false;
function enterCrusherPlace() {
  if (!roads) return;
  exitMoveMode();
  crusherPlaceMode = true;
  canvas.style.cursor = 'cell';
  showHint(`Click the map to place the crusher (${money(crusherPrice)}) · Esc to cancel`);
}
function exitCrusherPlace() {
  if (!crusherPlaceMode) return;
  crusherPlaceMode = false;
  canvas.style.cursor = '';
  hideHint();
}

// ── Floating hint banner ──
let hintEl = null;
function showHint(text) {
  if (!hintEl) { hintEl = document.createElement('div'); hintEl.className = 'place-hint'; document.querySelector('main').appendChild(hintEl); }
  hintEl.textContent = text;
  hintEl.hidden = false;
}
function hideHint() { if (hintEl) hintEl.hidden = true; }

// Update live values without rebuilding the panel (keeps the dropdown stable).
function updateAssetLive() {
  const v = fleet.selected;
  if (!v) return;
  if (v.type === 'oht') {
    const c = document.getElementById('asset-carry');
    if (c) c.textContent = `${Math.round(v.load)} t`;
  } else if (v.type === 'excavator') {
    const t = document.getElementById('asset-trucks');
    if (t) {
      const trucks = fleet.vehicles.filter((x) => x.type === 'oht' && x.shovel === v.label).map((x) => x.label);
      t.textContent = trucks.join(', ') || '—';
    }
  }
}

// ── Shop (buy assets) ──
const money = (n) => `$${n.toLocaleString('en-US')}`;

function openShop() { setMode('mouse'); shopEl.hidden = false; renderShop(); }
function closeShop() { shopEl.hidden = true; }

function renderShop() {
  const count = fleet ? fleet.vehicles.length : 0;
  const full = count >= maxAssets;
  const rows = catalog.map((c) => {
    const afford = creditValue >= c.price;
    const disabled = full || !afford;
    const reason = full ? 'Fleet full' : !afford ? 'Not enough $' : 'Buy';
    return `
      <div class="shop-row">
        <div class="shop-info">
          <b>${c.model}</b>
          <span class="shop-spec">${c.spec}</span>
        </div>
        <div class="shop-price">${money(c.price)}</div>
        <button class="shop-buy" data-id="${c.id}"${disabled ? ' disabled' : ''}>${reason}</button>
      </div>`;
  }).join('');

  // Extra crusher — buy then click the map to place it.
  const crusherFull = extraCrushers >= maxExtraCrushers;
  const crusherAfford = creditValue >= crusherPrice;
  const crusherReason = crusherFull ? 'Max reached' : !crusherAfford ? 'Not enough $' : 'Place…';
  const crusherRow = `
    <div class="shop-row">
      <div class="shop-info">
        <b>Crusher</b>
        <span class="shop-spec">Extra dump site — click the map to place it (${extraCrushers}/${maxExtraCrushers})</span>
      </div>
      <div class="shop-price">${money(crusherPrice)}</div>
      <button class="shop-buy" id="shop-buy-crusher"${crusherFull || !crusherAfford ? ' disabled' : ''}>${crusherReason}</button>
    </div>`;

  shopEl.innerHTML = `
    <div class="shop-card">
      <header class="shop-head">
        <span>Buy assets</span>
        <span class="shop-meta">${count}/${maxAssets} assets · ${money(creditValue)}</span>
        <button class="shop-close" aria-label="Close">×</button>
      </header>
      ${rows}
      ${crusherRow}
    </div>`;

  shopEl.querySelector('.shop-close').addEventListener('click', closeShop);
  for (const btn of shopEl.querySelectorAll('.shop-buy')) {
    if (btn.id === 'shop-buy-crusher') {
      btn.addEventListener('click', () => { closeShop(); enterCrusherPlace(); });
      continue;
    }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await net.buy(btn.dataset.id);
      if (r && r.ok) setCredit(r.credit);          // new asset arrives via the broadcast state
      else if (r && r.error === 'credit') flashShop('Not enough credit');
      else if (r && r.error === 'max') flashShop(`Maximum ${maxAssets} assets reached`);
      renderShop();
    });
  }
}

function flashShop(msg) {
  const head = shopEl.querySelector('.shop-meta');
  if (head) { head.textContent = msg; }
}

document.getElementById('shop-btn').addEventListener('click', () => {
  if (shopEl.hidden) openShop(); else closeShop();
});
// close when clicking the backdrop (outside the card)
shopEl.addEventListener('click', (e) => { if (e.target === shopEl) closeShop(); });

// ── About / How-to-play modal ──
const aboutEl = document.getElementById('about');
const closeAbout = () => { aboutEl.hidden = true; };
document.getElementById('about-btn').addEventListener('click', () => { aboutEl.hidden = !aboutEl.hidden; });
aboutEl.addEventListener('click', (e) => { if (e.target === aboutEl) closeAbout(); });
aboutEl.querySelector('.about-close').addEventListener('click', closeAbout);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAbout(); });

// ── Lobby / rooms (multiplayer) ──
const lobbyEl = document.getElementById('lobby');
const lobbyMsg = document.getElementById('lobby-msg');
const roomBadge = document.getElementById('room-badge');

function showLobby(msg) {
  lobbyEl.style.display = 'flex';
  lobbyMsg.textContent = msg || '';
}
function hideLobby() { lobbyEl.style.display = 'none'; }

net.onJoined = (code) => {
  hideLobby();
  roomBadge.hidden = false;
  roomBadge.textContent = `Room ${code}`;
  // keep the code in the URL so a refresh / shared link rejoins the same game
  const url = new URL(location.href);
  if (url.searchParams.get('room') !== code) {
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
  }
};

net.onJoinError = (reason) => {
  net.room = null;                          // stop auto-rejoining a dead room
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  showLobby(reason === 'room not found' ? 'Partie introuvable.' : `Erreur: ${reason}`);
};

document.getElementById('lobby-create').addEventListener('click', () => {
  showLobby('Création…');
  net.create();
});
const codeInput = document.getElementById('lobby-code');
const doJoin = () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < 4) { lobbyMsg.textContent = 'Entre un code valide.'; return; }
  showLobby('Connexion…');
  net.join(code);
};
document.getElementById('lobby-join-btn').addEventListener('click', doJoin);
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

// On load: auto-join the room from the URL, otherwise show the lobby.
(function bootstrap() {
  const code = new URL(location.href).searchParams.get('room');
  if (code) { showLobby('Connexion…'); net.join(code.toUpperCase()); }
  else showLobby();
})();
