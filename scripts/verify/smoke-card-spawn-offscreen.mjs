// Pendentes #188, achado ao vivo — `centeredSlot`'s collision ring-search
// (board-model.ts) walks a new card's slot outward to dodge an existing
// one, up to ~720px per axis. Three 860×660 browser cards spawned
// back-to-back at a 1280×800 window collide badly enough that the ring
// search lands the newest one almost a full card-height below the fold,
// with nothing to pan the view back to it — the user clicks "add", nothing
// visibly happens. addTerminalCard/addCardOfKind (App.tsx) now recenter on
// the new card whenever it lands off-center; this guards that stays fixed.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-card-spawn-offscreen-${CDP_PORT}`, import.meta.url).pathname;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();

try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Offscreen Spawn Smoke");
  await delay(500);

  async function spawnBrowserFromRail() {
    const addBtn = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector('[data-role="rail-add-card"]');
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    await page.click(addBtn.x, addBtn.y);
    await delay(300);
    const browserBtn = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.popover-row')].find((x) => x.dataset.kind === 'browser');
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    await page.click(browserBtn.x, browserBtn.y);
    await delay(700);
  }

  // Same viewport-vs-card-size collision that originally triggered the bug:
  // 3 full-size browser cards spawned in a row at the same viewport center.
  await spawnBrowserFromRail();
  await spawnBrowserFromRail();
  await spawnBrowserFromRail();

  const viewport = JSON.parse(await page.evalJs(`JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`));
  const rects = JSON.parse(
    await page.evalJs(`
      (() => {
        const frames = [...document.querySelectorAll('[data-kind="browser"]')];
        return JSON.stringify(frames.map((f) => {
          const r = f.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        }));
      })()
    `),
  );

  const last = rects[rects.length - 1];
  const lastCenterInView = last.cx >= 0 && last.cx <= viewport.w && last.cy >= 0 && last.cy <= viewport.h;
  check("the most recently rail-spawned browser card lands with its center in viewport", lastCenterInView, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
