// Exercises the radial menu spawn path (right-click empty canvas → pick a
// kind → card appears at that point) and the confirm-before-close gate
// for a live terminal — both added this session, both prone to silent
// regression from unrelated changes elsewhere in App.tsx (card kind
// unions, closeCard's animation/confirm split, etc).
import { startApp, stopApp, connectPage, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = 9402;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-card-lifecycle", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));

  // A point guaranteed empty: past the default board's one auto-seeded
  // card (spawns near the world origin) but still inside the 1280×800
  // default window.
  const point = { x: 950, y: 700 };
  await page.click(point.x, point.y, "right");
  await new Promise((r) => setTimeout(r, 300));
  check("radial menu opened", await page.evalJs(`!!document.querySelector(".radial-menu")`), true);
  check(
    "radial menu has 6 actions",
    await page.evalJs(`document.querySelectorAll(".radial-item").length`),
    6,
  );

  const stickyBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll(".radial-item")].find(b => b.title === "Nota");
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(stickyBtn.x, stickyBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  check("radial menu closed after pick", await page.evalJs(`!document.querySelector(".radial-menu")`), true);
  check("sticky card spawned", await page.evalJs(`document.querySelectorAll(".sticky-card").length`), 1);

  // Close-confirm gate: the auto-seeded bash terminal is "live" (no
  // spawnError/exitCode yet) — clicking its × should ask for
  // confirmation, not close immediately.
  // The terminal card header has two buttons (^C interrupt, then close) —
  // close is the last one, not the first.
  await page.evalJs(`document.querySelector(".terminal-card .card-head-actions button:last-child")?.click()`);
  await new Promise((r) => setTimeout(r, 300));
  check("confirm modal appeared for live terminal", await page.evalJs(`!!document.querySelector(".modal")`), true);
  check(
    "terminal card still present while confirm is open",
    await page.evalJs(`document.querySelectorAll(".terminal-card").length`),
    1,
  );

  await page.evalJs(`[...document.querySelectorAll(".modal-actions button")].find(b => b.textContent.includes("Fechar"))?.click()`);
  await new Promise((r) => setTimeout(r, 500));
  check("terminal card removed after confirming close", await page.evalJs(`document.querySelectorAll(".terminal-card").length`), 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
