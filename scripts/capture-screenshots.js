// Capture the README screenshots from the real app. Boots an in-process server
// on an ephemeral port, drives it with Playwright, and writes PNGs to
// docs/screenshots/.
//
// Requires Playwright + chromium:  npx playwright install chromium
// Run:                             node scripts/capture-screenshots.js

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { createServer } = require('../server/app');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const ADMIN_PASS = 'demo-pass';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const inst = createServer({ adminPass: ADMIN_PASS });
  await new Promise((r) => inst.server.listen(0, r));
  const base = `http://localhost:${inst.server.address().port}`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

  await page.goto(base);
  await page.click('#lobby-create');
  await page.waitForSelector('#lobby', { state: 'hidden' }).catch(() => {});
  await page.waitForTimeout(2000);                       // let the fleet render

  // Zoom toward the parking / demo loop, which sits at the map's top-left corner.
  const box = await (await page.$('#mine')).boundingBox();
  // The parking sits at the map's top-left corner: zoom there, then pan it toward
  // the centre so the demo loop (road + crusher + shovels) fills the frame.
  const zoomAt = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.08 };
  await page.mouse.move(zoomAt.x, zoomAt.y);
  for (let i = 0; i < 17; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(90); }
  await page.mouse.move(zoomAt.x, zoomAt.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.46, { steps: 14 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(900);
  await shot('game.png');

  // Block popup (click a block below the parking/loop).
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.75);
  await page.waitForTimeout(400);
  await shot('block-popup.png');
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + box.width * 0.92, box.y + box.height * 0.9);

  // Shop.
  await page.click('#shop-btn');
  await page.waitForTimeout(400);
  await shot('shop.png');
  await page.click('.shop-close');                       // close from inside the card

  // About / how-to-play.
  await page.click('#about-btn');
  await page.waitForTimeout(300);
  await shot('about.png');
  await page.click('.about-close');

  // Road mode: draw an L-shaped one-way road.
  await page.click('#mode-road');
  await page.waitForTimeout(200);
  const sx = box.x + box.width * 0.45, sy = box.y + box.height * 0.5;
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx + 180, sy, { steps: 12 });
  await page.mouse.move(sx + 180, sy + 130, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await shot('road-mode.png');
  await page.click('#mode-mouse');

  // Admin dashboard (separate context carrying Basic auth).
  const adminCtx = await browser.newContext({
    viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2,
    httpCredentials: { username: 'admin', password: ADMIN_PASS },
  });
  const adminPage = await adminCtx.newPage();
  await adminPage.goto(base + '/admin');
  await adminPage.waitForTimeout(800);
  await adminPage.screenshot({ path: path.join(OUT, 'admin.png'), fullPage: true });

  await browser.close();
  await new Promise((r) => inst.stop(r));
  console.log('screenshots written to', OUT);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
