// Capture the README screenshots from the real app. Serves the static build with
// serve.js on a local port, drives it with Playwright, and writes PNGs to
// docs/screenshots/.
//
// Requires Playwright + chromium:  npx playwright install chromium
// Run:                             node scripts/capture-screenshots.js

const path = require('path');
const fs = require('fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const PORT = process.env.PORT || 3219;
const base = `http://localhost:${PORT}`;

// Boot serve.js and wait until it answers.
function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'serve.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit',
  });
  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    (function poll() {
      http.get(base, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() > deadline) return reject(new Error('serve.js did not start'));
          setTimeout(poll, 150);
        });
    })();
  });
  return { proc, ready };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = startServer();
  await server.ready;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

  await page.goto(base);
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

  await browser.close();
  server.proc.kill();
  console.log('screenshots written to', OUT);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
