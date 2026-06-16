# ⛏ Mine Sim — Open Pit

A real-time, multiplayer **open-pit mine simulation**. You drill a grid of mining
blocks to reveal ore, draw a road network, and a fleet of vehicles (shovels and
haul trucks) automatically digs, hauls, and dumps ore at the crushers to earn
credit. Everything is authoritative server-side; browsers only render snapshots
and send commands.

```
drill ore → draw roads → shovels load trucks → trucks haul to crusher → credit
```

## Quick start

```bash
npm install
npm start                 # http://localhost:3200  (PORT env to override)
```

Open the URL, **create a game** (or join with a 5-letter code) and start playing.

### Controls

- **Scroll** to zoom, **hold right-click** to pan.
- **Click a block** to drill it (reveals composition, costs credit).
- **Click a vehicle** for details; drive it manually with the **arrow keys**
  (light vehicles can move diagonally). Haul trucks otherwise run on autopilot.
- Toolbar modes: **🖱 Mouse**, **✏️ Road** (draw), **🧽 Eraser**.
- **🛒 Buy assets** to expand the fleet (up to 25 vehicles).

## Gameplay model

- The mine is a grid of **blocks** (`game/mine.js`). Each weighs 10 000 t and
  holds dirt plus at most one ore type (`iron`, `copper`, `gold`, `carbon`), laid
  out in contiguous deposits. Composition stays hidden until a block is drilled.
- **Vehicles** (`game/world.js`):
  - **Excavators / shovels** — dig ore and load trucks; auto-relocate to the
    nearest explored ore block when their current block is exhausted.
  - **Haul trucks (OHT)** — 240 t payload, **road-only**, run the autopilot loop:
    `to_shovel → loading → to_crusher → dumping → …`, parking when idle.
  - **Light utility vehicle** — manual scout.
- **Crushers** are placed across the map; trucks dump there and you’re paid per
  tonne by ore value.
- You start with $100 000; drilling costs $5 000 per block.

## Truck autopilot & pathfinding

Trucks navigate the player-drawn road network with a **cached distance-field**
planner (`Autopilot` in `game/world.js`):

- A reverse BFS from each destination produces a shortest-path distance field,
  **respecting one-way road arrows** (you can never drive against the flow on
  autopilot; manual driving is exempt). Junctions allow every turn the connected
  roads support.
- Trucks greedily descend the field — always the **shortest, most direct** route,
  re-evaluated every tick. They never step backward in normal flow, so there is
  no back-and-forth jitter.
- A blocked step makes a truck wait briefly, then take a free **detour** if the
  network offers one. True **head-on deadlocks** on single lanes are broken by a
  committed *yield*: the lower-priority truck tucks into a pocket and holds until
  the other has passed.
- Distance fields are cached per goal-set and invalidated when roads change, so
  pathfinding costs ~0.01 ms/tick even with a full fleet.

> Tip: a **one-way loop** around your shovel and crusher roughly doubles haul
> throughput versus a single two-way lane, because trucks never meet head-on.

## Architecture

```
server.js            Express + ws. Rooms, 30 Hz tick loop, delta broadcasts.
game/
  world.js           Authoritative world: vehicles, roads, autopilot, economy.
  mine.js            Mine generation + block/ore model.
public/
  index.html         UI shell, lobby, canvas layers.
  app.js             Client bootstrap & input.
  components/        Renderers: mine, roads, vehicles, camera, net, popups.
```

- **Authoritative server.** All gameplay state lives in `World` and is advanced
  by `tick(dt)`. Clients render snapshots and send commands only.
- **Rooms.** Each room is an isolated `World` with a shareable 5-letter code.
  Ticks and broadcasts are per-room; empty rooms are frozen and reaped after a
  grace period.
- **Networking.** WebSocket JSON messages. The server sends a full `state` on
  join, then per-tick **deltas** (`live`) carrying only changed vehicle fields,
  touched blocks, and credit changes (broadcast at 15 Hz).

  | Client → server | Server → client |
  | --- | --- |
  | `create`, `join` | `joined`, `joinError`, `state` |
  | `drill`, `roads`, `buy`, `reset` | `drilled`, `roads`, `bought`, `vehicle` |
  | `control`, `assign`, `select`, `debug` | `live` (deltas) |

## Docker

```bash
docker build -t mine-sim .
docker run -p 3200:3200 mine-sim
```

`npm run docker:build` cross-builds (`linux/amd64,linux/arm64`) and pushes the
`jarod68/mine-sim:latest` image. The server listens on `PORT` (default 3200).

## License

MIT — see [LICENSE](LICENSE).
