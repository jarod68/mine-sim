import { defineConfig } from 'vitest/config';

// Server game logic (game/**) is plain CJS and runs in Node. Client modules
// (public/**) are browser ESM that touch the DOM/canvas, so those test files opt
// into happy-dom via `environmentMatchGlobs`.
export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [['test/client/**', 'happy-dom']],
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['game/**/*.js', 'public/components/**/*.js'],
      // Pure rendering paths (canvas drawing) are exercised but not asserted on;
      // we still report them so coverage reflects the whole project.
      thresholds: {
        // Whole project — guards against a big regression. Kept below the current
        // numbers because the client canvas renderers are intentionally untested.
        statements: 70,
        branches: 78,
        functions: 82,
        lines: 70,
        // The authoritative game logic is held to a high bar.
        'game/**': {
          statements: 92,
          branches: 80,
          functions: 92,
          lines: 92,
        },
      },
    },
  },
});
