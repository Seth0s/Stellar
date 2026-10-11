// Long-press opens the dual-ring radial; a real drag must not.
// Right-click is owned by BoardCanvasMenu (quick task); Q / long-press open the radial.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-radial-longpress-${CDP_PORT}`, import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // Empty board — a seeded terminal's xterm canvas covers the viewport and
  // steals pointerdown from the background hold handler.
  await bootIntoFreshSession(page, "Radial longpress", { spawnTerminal: false });

  const point = { x: 640, y: 400 };
  const hit = await page.evalJs(`
    (() => {
      const el = document.elementFromPoint(${point.x}, ${point.y});
      return (el && (el.classList.contains("viewport") || el.classList.contains("world") || el === document.querySelector(".viewport"))) ? "bg" : (el?.className || el?.tagName || "?");
    })()
  `);
  check("empty board hit-test is background", String(hit).includes("bg") || String(hit).includes("viewport") || String(hit).includes("world"), true);

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
  check(
    "dual rings render (outer disc + inner dashed)",
    await page.evalJs(`document.querySelectorAll(".radial-ring").length`),
    2,
  );
  check(
    "center hub is aria-live",
    await page.evalJs(`document.querySelector(".radial-hub")?.getAttribute("aria-live")`),
    "polite",
  );
  check(
    "four tools + eight spawns",
    await page.evalJs(`document.querySelectorAll(".radial-node--tool").length + document.querySelectorAll(".radial-node--spawn").length`),
    12,
  );
  check(
    "provider arc open by default on agent",
    await page.evalJs(`document.querySelectorAll("[data-radial-provider]").length > 0`),
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
