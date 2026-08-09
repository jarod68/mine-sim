# Unit tests (Vitest)

Fast, headless tests for the authoritative game logic and the client modules. Run
in Node; client modules opt into a `happy-dom` environment per file.

```bash
npm test              # run once
npm run test:watch    # watch mode
npm run coverage      # with istanbul coverage + thresholds
```

## Layout
- `game/` — the simulation (mine generation, world, vehicle, roads, autopilot),
  the exact modules the browser worker runs at runtime (`public/game/`).
- `client/` — browser ES modules (`roads`, `vehicle`, `camera`, `mine`);
  these files start with `// @vitest-environment happy-dom`.

## Conventions
- One `*.test.js` per module under test, mirroring the source path.
- Generation is RNG-seedable: `new World(seed)` / `generateMine(cols, rows, seed)`
  for deterministic maps. Prefer the spawn keep-out (blocks x≤46, y≤26) for
  coordinates that must never land on a random vein.
- Config: [`../../vitest.config.js`](../../vitest.config.js) (include glob, coverage
  thresholds — `public/game/**` is held to a high bar).
