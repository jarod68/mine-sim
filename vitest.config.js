import { defineConfig } from 'vitest/config';

// Server game logic (game/**) is plain CJS and runs in Node. Client modules
// (public/**) are browser ESM that touch the DOM/canvas; those test files opt
// into happy-dom with a top-of-file `// @vitest-environment happy-dom` comment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.js'],
    coverage: {
      // istanbul (not v8): instruments at transform time and merges coverage
      // correctly for a CJS module loaded by several test files — v8 under-counts
      // it (e.g. game/world.js loaded by both its own and the server tests).
      provider: 'istanbul',
      reporter: ['text', 'html'],
      include: ['game/**/*.js', 'public/components/**/*.js'],
      // Pure rendering paths (canvas drawing) are exercised but not asserted on;
      // we still report them so coverage reflects the whole project. Thresholds
      // are calibrated to the istanbul provider (counts statements/branches more
      // granularly than v8) and kept just below the current numbers so they still
      // catch a regression without being brittle.
      thresholds: {
        // Whole project — dominated by the intentionally-untested canvas renderers.
        statements: 68,
        branches: 64,
        functions: 76,
        lines: 69,
        // The authoritative game logic is held to a high bar. (A couple of points
        // of headroom absorb run-to-run variance from the random demo circuit.)
        'game/**': {
          statements: 87,
          branches: 77,
          functions: 91,
          lines: 91,
        },
      },
    },
  },
});
