import { test, expect } from '@playwright/test';

// Each fixture renders one client component on a deterministic page (fixed data,
// time frozen where needed) and we screenshot-compare its canvas to a committed
// baseline. Regenerate baselines after an intended visual change with
// `npm run test:visual:update`.
const fixtures = ['dozer', 'vein-mesh', 'roads'];

for (const name of fixtures) {
  test(`renders ${name}`, async ({ page }) => {
    await page.goto(`/test/visual/fixtures/${name}.html`);
    await page.waitForFunction(() => window.__ready === true, { timeout: 5000 });
    // Ensure the canvas has actually painted (two rAFs) before screenshotting.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.locator('#c')).toHaveScreenshot(`${name}.png`);
  });
}
