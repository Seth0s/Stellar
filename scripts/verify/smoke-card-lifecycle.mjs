// Exercises the radial menu spawn path (right-click empty canvas → pick a
// kind → card appears at that point) and the confirm-before-close gate
// for a live terminal — both added this session, both prone to silent
// regression from unrelated changes elsewhere in App.tsx (card kind
// unions, closeCard's animation/confirm split, etc).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9402;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-card-lifecycle", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // DESIGN-BACKLOG.md item 8 — boots to Home now; this script needs a real
  // board (and its auto-seeded terminal) to exercise the radial menu and
  // close-confirm gate against.
  await bootIntoFreshSession(page);

  // A point guaranteed empty: past the default board's one auto-seeded
  // card (spawns near the world origin at cascadeSlot(0) — 860×660 as of
  // DESIGN-BACKLOG.md item 12, achado 3, so its box covers roughly
  // (40,40)-(900,700)) but still inside the 1280×800 default window WITH
  // enough margin for the radial menu's own spread (RADIUS 88px + button
  // size, RadialMenu.tsx) — too close to a window edge clips some items
  // off-screen and makes them unclickable (confirmed the hard way: (1150,
  // 740) opened the menu fine but its bottom items landed past y=800).
  const point = { x: 1080, y: 400 };
  await page.click(point.x, point.y, "right");
  await new Promise((r) => setTimeout(r, 300));
  check("radial menu opened", await page.evalJs(`!!document.querySelector(".radial-menu")`), true);
  check(
    // 4 tool switches (item 1 revisited) + 7 spawn actions (item 12, Fase
    // B added "chat" to the spawn group).
    "radial menu has 11 actions (4 tools + 7 spawn)",
    await page.evalJs(`document.querySelectorAll(".radial-item").length`),
    11,
  );
  check(
    "pointer tool shows as active (default tool on a fresh board)",
    await page.evalJs(`document.querySelector('.radial-item[title="Ponteiro"]')?.classList.contains("active")`),
    true,
  );

  // Item 1 revisited — a tool-switch item (not just spawn) picked from
  // the radial menu actually changes the active tool, reflected on the
  // matching rail button. Checked (and reverted to pointer) before the
  // sticky-spawn check below, which needs `point` to still be empty —
  // both the terminal and the sticky card spawn at the full 860×660
  // spawn box, together covering nearly the entire default 1280×800
  // window once the sticky exists, so there's no second empty point left
  // to reopen the menu at afterward (confirmed the hard way).
  const penBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll(".radial-item")].find(b => b.title === "Caneta");
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(penBtn.x, penBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  check(
    "picking 'Caneta' from the radial menu activates the pen tool on the rail",
    await page.evalJs(`document.querySelector('.rail-btn[title^="Caneta"]')?.classList.contains("active")`),
    true,
  );
  check("radial menu closed after picking a tool", await page.evalJs(`!document.querySelector(".radial-menu")`), true);
  await page.evalJs(`document.querySelector('.rail-btn[title^="Ponteiro"]')?.click()`);
  await new Promise((r) => setTimeout(r, 200));

  await page.click(point.x, point.y, "right");
  await new Promise((r) => setTimeout(r, 300));
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
