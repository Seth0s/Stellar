// Cheapest possible regression catcher: does the app even come up and
// render its own chrome? Run this first when something feels broken —
// it fails fast on "the whole UI is dark" class of bugs before spending
// time on a more specific smoke script.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-boot-${CDP_PORT}`, import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const errors = [];
  const page = await connectPage(CDP_PORT);
  page.onEvent((msg) => {
    if (msg.method !== "Runtime.exceptionThrown") return;
    const description = msg.params.exceptionDetails.exception?.description ?? "";
    // Known, already-caught fallback on this GPU-disabled machine —
    // xterm's WebGL addon throws inside term.open(), useTerminal.ts
    // catches it and falls back to the canvas2d renderer (see its own
    // comments). CDP still reports it via Runtime.exceptionThrown even
    // though the app recovers; not a regression to fail this check on.
    if (description.includes("WebGL2 not supported")) return;
    errors.push(description || msg.params.exceptionDetails.text);
  });
  await new Promise((r) => setTimeout(r, 1000));

  // DESIGN-BACKLOG.md item 8 — boots to Home now, not straight into a
  // board (no boards exist yet on a fresh profile, so no rail/topbar/
  // auto-seeded terminal until a session is actually created).
  check("viewport rendered", await page.evalJs(`!!document.querySelector(".viewport")`), true);
  check("home screen rendered on first boot", await page.evalJs(`!!document.querySelector(".home")`), true);
  check("home empty state shown (no sessions yet)", await page.evalJs(`!!document.querySelector(".home-empty")`), true);

  await bootIntoFreshSession(page);
  check("rail rendered once a session exists", await page.evalJs(`document.querySelectorAll(".rail-btn").length`), (n) => n >= 6);
  check("topbar rendered once a session exists", await page.evalJs(`!!document.querySelector(".topbar")`), true);
  check(
    "bootIntoFreshSession's spawned bash terminal is present",
    await page.evalJs(`document.querySelectorAll('[data-kind="terminal"]').length`),
    1,
  );
  check("no uncaught exceptions on boot", errors, (arr) => arr.length === 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
