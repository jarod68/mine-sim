import { test, expect } from '@playwright/test';

// Each fixture renders one client component on a deterministic page (fixed data,
// time frozen where needed) and we screenshot-compare its canvas to a committed
// baseline. Regenerate baselines after an intended visual change with
// `npm run test:visual:update`.
const fixtures = ['assets', 'blocks', 'vein-mesh', 'roads', 'parking-crusher'];

for (const name of fixtures) {
  test(`renders ${name}`, async ({ page }) => {
    await page.goto(`/test/visual/fixtures/${name}.html`);
    await page.waitForFunction(() => window.__ready === true, { timeout: 5000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.locator('#c')).toHaveScreenshot(`${name}.png`);
  });
}

// The default map's terrain (the rich veins) is deterministic for a given seed —
// render a seeded mine overview. (Roads / crushers / fleet use unseeded
// Math.random, so they're left out to keep the baseline stable.)
test('renders the seeded default map', async ({ page }) => {
  const { generateMine } = await import('../../game/mine.js');
  const mine = generateMine(190, 139, 12345);
  const blocks = [];
  for (const row of mine.blocks)
    for (const b of row)
      if (b.prep) blocks.push({ x: b.x, y: b.y, explored: false, prep: true, prepPasses: b.prepPasses, prepMax: b.prepMax });
  const state = { cols: 190, rows: 139, view: { w: 7942, h: 5560 }, blocks };

  await page.addInitScript((s) => { window.__seedState = s; }, state);
  await page.goto('/test/visual/fixtures/seed-map.html');
  await page.waitForFunction(() => window.__ready === true, { timeout: 5000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.locator('#c')).toHaveScreenshot('seed-map.png');
});
