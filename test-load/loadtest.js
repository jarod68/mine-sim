// Progressive load test for a DEPLOYED mine-sim. Runs entirely from YOUR machine
// (nothing is installed on the server): it opens WebSocket clients, ramps up
// parallel games (rooms) and players, simulates per-player commands, and measures
// the drill round-trip latency to detect when the server saturates.
//
//   node scripts/loadtest.js --url wss://play.holtz.fr
//   node scripts/loadtest.js --url wss://play.holtz.fr --players 6 --max-games 40 --add-every 3000
//
// Metric to watch: drill RTT (p50/p95). The sim runs on ONE Node thread, so when
// the 30 Hz tick can't keep up with the number of live rooms, RTT climbs sharply
// — that's your ceiling. Pair it with the server-side RAM/CPU commands (README of
// this script / the chat) to correlate.
//
// ⚠ The server caps connections per IP (MAX_CONN_PER_IP = 24). From a single box
// you can therefore open at most ~24 sockets (≈24 solo games, or 6 games × 4
// players). To go higher, run this from several machines/IPs in parallel and sum
// the results (or raise that cap on a throwaway test deploy).

const WebSocket = require('ws');

// ── args ──
const args = Object.fromEntries(process.argv.slice(2).join('=').split('--').filter(Boolean)
  .map((s) => s.trim().split('=')).map(([k, v]) => [k, v ?? true]));
const URL = args.url || 'wss://play.holtz.fr';
const PLAYERS = +(args.players || 4);          // players per game (incl. the creator)
const MAX_GAMES = +(args['max-games'] || 24);  // target parallel games
const ADD_EVERY = +(args['add-every'] || 4000);// ms between spawning a game
const CMD_RATE = +(args['cmd-rate'] || 2);     // commands/player/second
const SOAK_MS = +(args.soak || 60000);         // hold at max this long, then summarise
const PRINT_MS = +(args.print || 2000);
const INSECURE = !!args.insecure;              // skip TLS cert check

const COLS = 190, ROWS = 139;
const wsOpts = INSECURE ? { rejectUnauthorized: false } : {};
const rnd = (n) => Math.floor(Math.random() * n);

// ── global metrics ──
const m = {
  open: 0, closed: 0, games: 0, players: 0,
  joinErrors: 0, connErrors: 0, connCapHit: false,
  msgsIn: 0, drillsSent: 0, drillAcks: 0, rtt: [],
};
const sockets = new Set();
let stopping = false;

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// One simulated player socket. `joinCode` null ⇒ creates a new game.
function spawnPlayer(joinCode, onCode) {
  const ws = new WebSocket(URL, wsOpts);
  sockets.add(ws);
  const pending = new Map();     // "x,y" → sent timestamp (drill RTT)
  let loop = null;

  ws.on('open', () => {
    m.open++;
    ws.send(JSON.stringify(joinCode ? { t: 'join', room: joinCode } : { t: 'create' }));
  });

  ws.on('message', (raw) => {
    m.msgsIn++;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'joined') {
      m.players++;
      if (!joinCode && onCode) onCode(msg.room);
      loop = setInterval(() => sendCommand(ws, pending), 1000 / CMD_RATE);
    } else if (msg.t === 'joinError') {
      m.joinErrors++;
    } else if (msg.t === 'drilled') {
      const t0 = pending.get(`${msg.x},${msg.y}`);
      if (t0 != null) { pending.delete(`${msg.x},${msg.y}`); m.drillAcks++; m.rtt.push(Date.now() - t0); }
    }
  });

  ws.on('close', (code) => {
    m.closed++; sockets.delete(ws); if (loop) clearInterval(loop);
    if (code === 1013) m.connCapHit = true;   // server: "too many connections"
  });
  ws.on('error', () => { m.connErrors++; });
  return ws;
}

// A realistic-ish player action: mostly timed drills (for RTT), some road edits
// and the occasional move-to / buy, to exercise broadcasts + the autopilot.
function sendCommand(ws, pending) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const r = Math.random();
  if (r < 0.7) {
    const x = rnd(COLS), y = rnd(ROWS);
    pending.set(`${x},${y}`, Date.now());
    m.drillsSent++;
    ws.send(JSON.stringify({ t: 'drill', x, y }));
  } else if (r < 0.85) {
    const gx = rnd(COLS * 2 - 6), gy = rnd(ROWS * 2);
    const cells = Array.from({ length: 6 }, (_, i) => ({ gx: gx + i, gy, dir: { dx: 1, dy: 0 } }));
    ws.send(JSON.stringify({ t: 'roads', cells }));
  } else if (r < 0.95) {
    ws.send(JSON.stringify({ t: 'moveTo', label: 'LV01', gx: rnd(COLS * 2), gy: rnd(ROWS * 2) }));
  } else {
    ws.send(JSON.stringify({ t: 'buy', id: 'T264' }));
  }
}

function spawnGame() {
  if (m.connCapHit || stopping) return;
  m.games++;
  spawnPlayer(null, (code) => {
    for (let i = 1; i < PLAYERS; i++) spawnPlayer(code);
  });
}

// ── ramp + reporting ──
console.log(`load test → ${URL}  (${PLAYERS} players/game, +1 game every ${ADD_EVERY}ms, up to ${MAX_GAMES})`);
console.log('time   games  sockets  players  in/s   drill p50/p95   sent/ack   errs');
let inPrev = 0; const t0 = Date.now();
const printer = setInterval(() => {
  const dt = PRINT_MS / 1000;
  const inRate = Math.round((m.msgsIn - inPrev) / dt); inPrev = m.msgsIn;
  const p50 = pct(m.rtt, 0.5), p95 = pct(m.rtt, 0.95);
  m.rtt.length = 0;
  const t = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
  console.log(`${t}s  ${String(m.games).padStart(5)}  ${String(m.open - m.closed).padStart(7)}  ${String(m.players).padStart(7)}  ${String(inRate).padStart(4)}  ${String(p50).padStart(5)}/${String(p95).padEnd(5)}ms  ${m.drillsSent}/${m.drillAcks}  ${m.joinErrors + m.connErrors}${m.connCapHit ? '  [conn-cap hit]' : ''}`);
}, PRINT_MS);

const ramp = setInterval(() => {
  if (m.games >= MAX_GAMES || m.connCapHit) { clearInterval(ramp); setTimeout(finish, SOAK_MS); return; }
  spawnGame();
}, ADD_EVERY);
spawnGame();   // first one immediately

function finish() {
  stopping = true;
  clearInterval(printer);
  console.log('\n── summary ──');
  console.log(`peak live sockets : ${m.open - m.closed}  (games=${m.games}, players=${m.players})`);
  console.log(`drills sent/acked : ${m.drillsSent}/${m.drillAcks}  (loss ${(100 * (1 - m.drillAcks / Math.max(1, m.drillsSent))).toFixed(1)}%)`);
  console.log(`errors            : join=${m.joinErrors} conn=${m.connErrors}${m.connCapHit ? '  (hit the per-IP connection cap — run from more IPs to go higher)' : ''}`);
  for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => { console.log('\n(stopping…)'); finish(); });
