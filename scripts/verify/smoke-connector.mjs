// The connector-drag gesture (useConnectorDrag.ts) — drag from one card's
// body to another while the connector tool is active should draw and
// persist a link between them. Not covered by the other smoke scripts.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-connector-${CDP_PORT}`, import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  // DESIGN-BACKLOG.md item 8 — boots to Home now; the connector drag needs
  // an actual board (rail) to spawn sticky notes onto.
  await bootIntoFreshSession(page);

  // Rail reorg (2.2's "menu único de Ferramentas/Cards") moved card
  // creation behind an "Adicionar card" popover for every kind but
  // terminal — `spawnCard` (cdp-client.mjs) handles both shapes.
  async function spawnSticky() {
    await spawnCard(page, "sticky");
  }
  await spawnSticky();
  await spawnSticky();
  check("two sticky cards spawned", await page.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`), 2);

  // The two spawn near-fully overlapping (centeredSlot's 36px stagger is
  // tiny next to an 860x660 card — DESIGN-BACKLOG.md item 12, achado 3 —
  // in a 1280x800 window, worse now than at the old 720x560). Zoom out
  // first (same fix smoke-group-select.mjs already uses) so there's real
  // screen-space margin regardless of card size, THEN drag the second
  // one's header (already pointer-tool-tested gesture, see CardFrame.tsx)
  // well clear of the first before touching the connector tool at all.
  const zoomOutBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.title === "Diminuir zoom");
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  for (let i = 0; i < 6; i++) await page.click(zoomOutBtn.x, zoomOutBtn.y);
  await new Promise((r) => setTimeout(r, 200));

  const secondHead = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelectorAll('[data-kind="sticky"] .card-head')[1];
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  // Absolute, not relative — the two cards' actual spawn position isn't
  // guaranteed (depends on however many cards already exist on the
  // board), so an offset from the current position risks landing
  // off-screen. A fixed, safely-on-screen point for an 1280x800 window
  // doesn't have that problem.
  const dest = { x: 1000, y: 700 };
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: secondHead.x, y: secondHead.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dest.x, y: dest.y, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dest.x, y: dest.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));

  const [headA, headB] = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-kind="sticky"] .card-head')].map(el => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }))
    `),
  );

  // Switch to the connector tool (keyboard shortcut "c", same as a human).
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", text: "c" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC" });
  await new Promise((r) => setTimeout(r, 200));
  check(
    "connector tool active",
    await page.evalJs(`document.querySelector('.rail-btn[title^="Conector"]')?.classList.contains("active")`),
    true,
  );

  const overlayPathsBefore = await page.evalJs(`document.querySelectorAll(".board-overlay path").length`);

  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: headA.x, y: headA.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (headA.x + headB.x) / 2, y: (headA.y + headB.y) / 2, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: headB.x, y: headB.y, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: headB.x, y: headB.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 500));

  const overlayPathsAfter = await page.evalJs(`document.querySelectorAll(".board-overlay path").length`);
  check("a new connector path was drawn", overlayPathsAfter, (n) => n > overlayPathsBefore);

  page.close();
} finally {
  await stopApp(app);
}
finish();
