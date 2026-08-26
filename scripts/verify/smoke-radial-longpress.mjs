// DESIGN-BACKLOG.md item 1 revisited — press-and-hold as a second gatilho
// for the radial menu, alongside right-click (already covered by
// smoke-card-lifecycle.mjs). Held still past the 450ms timer opens it; a
// real drag (moved past the 6px threshold early) must NOT open it — that
// would make ordinary panning pop the menu constantly.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9412;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-radial-longpress", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page);

  // Same empty point smoke-card-lifecycle.mjs uses, for the same reason
  // (clear of the auto-seeded terminal's 860×660 box, with margin for the
  // radial menu's own spread).
  const point = { x: 1080, y: 400 };

  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 600));
  check(
    "radial menu opens from a held-still left-button press (long-press)",
    await page.evalJs(`!!document.querySelector(".radial-menu")`),
    true,
  );
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evalJs(`document.querySelector(".radial-backdrop")?.click()`);
  await new Promise((r) => setTimeout(r, 200));

  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 50));
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x + 60,
    y: point.y + 40,
    button: "left",
    pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 600));
  check(
    "a real drag (moved early) does not open the radial menu",
    await page.evalJs(`!!document.querySelector(".radial-menu")`),
    false,
  );
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x + 60,
    y: point.y + 40,
    button: "left",
    pointerType: "mouse",
  });

  page.close();
} finally {
  await stopApp(app);
}
finish();
