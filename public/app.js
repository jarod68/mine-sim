// Thin client: renders authoritative server snapshots and sends commands over a
// single WebSocket (no HTTP polling). The server owns the entire simulation.

import { GameCanvas, VIEW_W, VIEW_H } from './components/game-canvas.js';
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
let maxAssets = 25;
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

net.onState = (state) => (built ? refresh(state) : build(state));
net.onLive = (data) => onLive(data);
net.onRoads = (cells) => { if (roads) roads.setNetwork(cells); };

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
  const setMode = (mode) => {
    roads.setTool(tool[mode]);
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
  popup.show(block, pos, { onDrill: drill, drillCost });
};

let roadsSaveTimer = null;
function scheduleRoadsSave() {
  clearTimeout(roadsSaveTimer);
  roadsSaveTimer = setTimeout(() => net.roads(roads.serialize()), 250);
}

// ── first full state → build everything once ──
function build(state) {
  built = true;
  paintLegend();
  drillCost = state.drillCost;
  catalog = state.catalog || [];
  maxAssets = state.maxAssets || 25;
  setCredit(state.credit);
  game = new GameCanvas(canvas, state, onBlockClick);
  blockW = VIEW_W / state.cols;
  blockH = VIEW_H / state.rows;

  const zoneCols = state.cols * 2;
  const zoneRows = state.rows * 2;
  const grid = { zoneCols, zoneRows, zoneW: VIEW_W / zoneCols, zoneH: VIEW_H / zoneRows };

  roads = new Roads(document.getElementById('roads-layer'), { w: VIEW_W, h: VIEW_H }, grid);
  const PARK = state.parking;
  roads.addParking(PARK.x, PARK.y, PARK.w, PARK.h);
  roads.setCrushers(state.crushers);
  if (state.roads) roads.load(state.roads);
  roads.onChange = scheduleRoadsSave;

  fleet = new Fleet(document.getElementById('vehicle-layer'), { w: VIEW_W, h: VIEW_H }, grid);
  fleet.onControl = (label, cmd) => net.control(label, cmd);
  fleet.onSelect = (v) => { syncSelection(v); renderAsset(v); };
  fleet.sync(state.vehicles);
  fleet.snapToTargets();

  setupModes();
  renderAsset(null);

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const w = toWorld(e.clientX, e.clientY, rect);
    const v = fleet.selectAt(w.x, w.y);
    if (v) e.stopPropagation();
    else fleet.setSelected(null);
  }, true);

  setupCamera();
}

// ── subsequent full state (after reset or a purchase) → refresh data ──
function refresh(state) {
  drillCost = state.drillCost;
  catalog = state.catalog || catalog;
  maxAssets = state.maxAssets || maxAssets;
  game.setMine(state);
  roads.setCrushers(state.crushers);
  // Reload the server's road network WITHOUT firing onChange — a server-driven
  // refresh (reconnect, purchase) must never echo roads back (and never wipe
  // them). setNetwork keeps the parking pads intact.
  roads.setNetwork(state.roads || []);
  fleet.sync(state.vehicles);
  setCredit(state.credit);   // last → refreshes the open shop with the new count
  fleet.snapToTargets();
}

// ── live delta updates (≤ 15 Hz, only what changed) ──
function onLive(data) {
  if (typeof data.credit === 'number') setCredit(data.credit);
  if (!fleet) return;
  if (data.vehicles && data.vehicles.length) fleet.applyDeltas(data.vehicles);
  if (data.blocks && data.blocks.length) {
    for (const b of data.blocks) game.mine.blocks[b.y][b.x] = b;
    game.render();
  }
  if ('debug' in data) fleet.debugPaths = data.debug;
  updateAssetLive();
}

// ── Camera: scroll to zoom, right-drag to pan ──
function setupCamera() {
  const stage = document.querySelector('main');
  const rerender = () => { game.render(); roads.render(); };
  const resizeAll = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    game.resize(w, h);
    roads.resize(w, h);
    fleet.resize(w, h);
  };
  const minScale = () => Math.min(stage.clientWidth / VIEW_W, stage.clientHeight / VIEW_H) * 0.5;
  const fit = () => {
    const s = Math.min(stage.clientWidth / VIEW_W, stage.clientHeight / VIEW_H);
    camera.scale = s;
    camera.ox = (stage.clientWidth - VIEW_W * s) / 2;
    camera.oy = (stage.clientHeight - VIEW_H * s) / 2;
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
  let parts = [item('Model', v.model), item('Name', v.label)];

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

  assetEl.innerHTML = `<span class="atitle">Asset</span>${parts.join('')}`;

  const sel = assetEl.querySelector('#asset-shovel');
  if (sel) {
    sel.addEventListener('change', (e) => net.assign(v.label, e.target.value || null));
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

function openShop() { shopEl.hidden = false; renderShop(); }
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

  shopEl.innerHTML = `
    <div class="shop-card">
      <header class="shop-head">
        <span>Buy assets</span>
        <span class="shop-meta">${count}/${maxAssets} assets · ${money(creditValue)}</span>
        <button class="shop-close" aria-label="Close">×</button>
      </header>
      ${rows}
    </div>`;

  shopEl.querySelector('.shop-close').addEventListener('click', closeShop);
  for (const btn of shopEl.querySelectorAll('.shop-buy')) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await net.buy(btn.dataset.id);
      if (r && r.ok) setCredit(r.credit);          // new asset arrives via the broadcast state
      else if (r && r.error === 'credit') flashShop('Not enough credit');
      else if (r && r.error === 'max') flashShop('Maximum 25 assets reached');
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
