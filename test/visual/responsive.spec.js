import { test, expect } from '@playwright/test';

// Responsive chrome: render the REAL index.html top bar at a desktop and a phone
// width and snapshot it, to lock the layout (compact legend, icon-only buttons,
// nothing clipped/hidden on resize). Served statically, so the app sits at the
// lobby with no socket — we hide the lobby and paint the legend swatches (the
// running app would, via build(state)) so the snapshot is representative + stable.
const swatchCSS = `
  #lobby { display: none !important; }
  .sw[data-ore="unexplored"] { background: #2f6b56; }
  .sw[data-ore="dirt"]       { background: #4a2f19; }
  .sw[data-ore="iron"]       { background: #9a5ce6; }
  .sw[data-ore="copper"]     { background: #ff9146; }
  .sw[data-ore="gold"]       { background: #f0e260; }
  .sw[data-ore="carbon"]     { background: #0c0c10; }
`;

const views = [
  ['chrome-desktop', { width: 1366, height: 768 }],
  ['chrome-mobile', { width: 390, height: 844 }],
];

for (const [name, viewport] of views) {
  test(`renders ${name} top bar`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/public/index.html');
    await page.addStyleTag({ content: swatchCSS });
    await page.waitForSelector('.topbar');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(page.locator('.topbar')).toHaveScreenshot(`${name}.png`);
  });
}
