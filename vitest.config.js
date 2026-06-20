import { defineConfig } from 'vitest/config';

// Server game logic (game/**) is plain CJS and runs in Node. Client modules
// (public/**) are browser ESM that touch the DOM/canvas; those test files opt
// into happy-dom with a top-of-file `// @vitest-environment happy-dom` comment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.js'],
    coverage: {
      // v8 (not istanbul): istanbul instruments at transform time and MISSES the
      // game/ modules loaded through world.js's CJS require() chain (they'd show
      // 0%); v8 measures actual V8 execution, so it counts every module the tests
      // exercise — incl. the autopilot/vehicle/roads split out of world.js.
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['game/**/*.js', 'public/components/**/*.js'],
      // Pure rendering paths (canvas drawing) are exercised but not asserted on;
      // we still report them so coverage reflects the whole project. Thresholds
      // sit just below the current numbers so they catch a regression without
      // being brittle (a couple of points absorb run-to-run variance from the
      // random demo circuit / crusher placement).
      thresholds: {
        // Whole project — dominated by the intentionally-untested canvas renderers.
        statements: 66,
        branches: 54,
        functions: 70,
        lines: 68,
        // The authoritative game logic is held to a high bar.
        'game/**': {
          statements: 76,
          branches: 57,
          functions: 82,
          lines: 80,
        },
      },
    },
  },
});
