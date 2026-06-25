# Robot Framework end-to-end tests

Browser-driven smoke tests that exercise the **real** stack: a freshly started
`node server.js`, the actual client served over HTTP/WebSocket, and a real
Chromium driven by the [Browser library](https://robotframework-browser.org/)
(Playwright under the hood).

These complement the fast Vitest unit tests and the Playwright visual-regression
suite — here we assert end-to-end behaviour through the UI.

## Setup (once)

```bash
pip install -r test/robot/requirements.txt
rfbrowser init          # downloads the browser binaries for the Browser library
```

## Run

```bash
npm run test:robot      # → robot --outputdir test/robot/results test/robot
```

The suite starts its own server on port **3781** (isolated DB in the results
dir, `TEST_MODE=1`), opens the app, and tears everything down afterwards. Run
artifacts (`log.html`, `report.html`, `output.xml`) land in
`test/robot/results/` (git-ignored).

Run headed for debugging:

```bash
robot -v HEADLESS:False test/robot
```

## Scenarios

`default_assets.robot` (each test starts from a freshly seeded game):

- **Default fleet is displayed after seeding a game** — asserts the Assets panel
  lists exactly the nine default vehicles (`LV01`, `HEX01–04`, `OHT01–04`).
- **Buying an asset grows the fleet and spends credit** — buys the $25,000 Light
  Utility Vehicle and asserts the balance drops $100,000 → $75,000 and the fleet
  grows to ten.
