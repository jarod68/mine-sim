# Visual tests (Playwright)

Screenshot-regression tests for the canvas renderers. Each fixture renders one
client component on a deterministic page (fixed data, time frozen where the
render depends on it) and the spec compares its canvas to a committed baseline.

```bash
npm run test:visual           # compare against baselines
npm run test:visual:update    # regenerate baselines after an intended change
```

First run needs the browser once: `npx playwright install chromium`.

## How it works
- [`serve.cjs`](serve.cjs) — a tiny static server rooted at the project, started
  by [`../../playwright.config.js`](../../playwright.config.js) as its `webServer`, so
  fixtures can import the real modules from `/public/components/*`.
- `fixtures/*.html` — minimal pages that import a component and draw it with
  fixed data, then set `window.__ready = true`.
- `components.spec.js` — loads each fixture, waits for `__ready` + a paint, and
  asserts `toHaveScreenshot()`.

## Baselines
- Committed under `components.spec.js-snapshots/`, suffixed by platform
  (e.g. `-darwin.png`). A different OS (CI on Linux) needs its own baselines —
  generate them there with `npm run test:visual:update`.
- A small `maxDiffPixelRatio` absorbs sub-pixel anti-aliasing; larger diffs fail.
- Tests run serially (`workers: 1`) — canvas paint timing is flaky under parallel
  contention.

## Adding a fixture
1. Add `fixtures/<name>.html` rendering the component deterministically; set
   `window.__ready = true` when done.
2. Add `<name>` to the list in `components.spec.js`.
3. `npm run test:visual:update` to write the baseline, then commit it.
