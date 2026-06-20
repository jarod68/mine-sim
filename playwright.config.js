import { defineConfig, devices } from '@playwright/test';

// Visual-regression tests: render real client components on deterministic fixture
// pages and screenshot-compare them against committed baselines. The webServer
// serves the project root so fixtures can import /public/components/*.
const PORT = 5180;

export default defineConfig({
  testDir: './test/visual',
  // Serial: the fixtures share one static server and canvas screenshots are
  // sensitive to render/paint timing under parallel contention.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: 'node test/visual/serve.cjs',
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 2,   // crisp canvas
  },
  expect: {
    // Small tolerance absorbs sub-pixel AA differences; large diffs still fail.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
});
