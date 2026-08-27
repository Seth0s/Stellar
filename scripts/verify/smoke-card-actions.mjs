// DESIGN-BACKLOG.md item 7 (fluxo de uso) — duplicar card (Ctrl/Cmd+D) and
// jump-to-card (Rail's "localizar card" popover).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9409;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-card-actions", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  // DESIGN-BACKLOG.md item 8 — boots to Home now; create a real session first.
  await bootIntoFreshSession(page);

  const initialCount = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelectorAll('.card-frame').length)`));
  check("bootIntoFreshSession leaves one bash terminal to work with", initialCount, 1);

  // Ctrl+D duplicates the topmost card (the only one there is right now).
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "d", code: "KeyD", modifiers: 2, windowsVirtualKeyCode: 68 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "d", code: "KeyD", modifiers: 2, windowsVirtualKeyCode: 68 });
  await new Promise((r) => setTimeout(r, 500));
  const afterDuplicate = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelectorAll('.card-frame').length)`));
  check("Ctrl+D duplicates the topmost card", afterDuplicate, 2);

  const providers = JSON.parse(
    await page.evalJs(`
      (() => {
        const cards = [...document.querySelectorAll('.terminal-card .card-tag')].map((t) => t.textContent.trim());
        return JSON.stringify(cards);
      })()
    `),
  );
  check("duplicate is also a bash terminal (same provider)", providers.filter((p) => p === "bash").length, 2);

  // 2026-08-27 — "facilitar área de drag, é difícil fazer o drag atual no
  // header": CardTag.tsx's static (non-editing) label used to carry
  // `data-no-drag`, which CardFrame.tsx's onHeaderPointerDown excludes —
  // a drag starting exactly on the "BASH" pill (often the most visually
  // "grabbable" spot) silently did nothing. Confirms it now actually
  // moves the card, same down→move→up-in-one-call real-drag pattern used
  // throughout this suite.
  const tagBefore = JSON.parse(
    await page.evalJs(`
      (() => {
        const tag = document.querySelector('.terminal-card .card-tag');
        const frame = tag.closest('.card-frame');
        const t = tag.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        return JSON.stringify({ tagX: t.x + t.width / 2, tagY: t.y + t.height / 2, frameLeft: f.left, frameTop: f.top });
      })()
    `),
  );
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: tagBefore.tagX, y: tagBefore.tagY, button: "left", clickCount: 1, pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: tagBefore.tagX + 60, y: tagBefore.tagY + 40, button: "left", pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: tagBefore.tagX + 60, y: tagBefore.tagY + 40, button: "left", clickCount: 1, pointerType: "mouse",
  });
  await new Promise((r) => setTimeout(r, 300));
  const frameAfter = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelector('.terminal-card').closest('.card-frame').getBoundingClientRect())`),
  );
  check(
    "dragging from the card-tag pill itself actually moves the card (used to be blocked)",
    frameAfter.left > tagBefore.frameLeft && frameAfter.top > tagBefore.frameTop,
    true,
  );

  // Pan the board far away so both cards land off-screen, then use
  // "localizar card" to jump back to one — same down/move/up-in-one-call
  // pattern the other smoke scripts use for real drags (see AGENTS.md).
  // (1200, 750): the two overlapping cards (cascadeSlot(0) + a +32/+32
  // duplicate) only cover roughly (40,40)-(792,632) at boot zoom/pan —
  // this corner is clear of both, so the drag grabs the board background,
  // not a card.
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1200, y: 750, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: -1500, y: -1500, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: -1500, y: -1500, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));
  const offScreenAfterPan = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify(r.right < 0 || r.bottom < 0);
      })()
    `),
  );
  check("panning far away moves cards off-screen (sanity check)", offScreenAfterPan, true);

  const findBtnCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.rail-btn')].find((x) => x.title === "Localizar card");
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(findBtnCoords.x, findBtnCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  const popoverRows = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelectorAll('.find-card-row').length)`),
  );
  check("localizar-card popover lists both cards", popoverRows, 2);

  const firstRowCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const r = document.querySelector('.find-card-row').getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(firstRowCoords.x, firstRowCoords.y);
  await new Promise((r) => setTimeout(r, 500));
  const cardVisibleAfterJump = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame');
        if (!el) return JSON.stringify(false);
        const r = el.getBoundingClientRect();
        return JSON.stringify(r.left < window.innerWidth && r.right > 0 && r.top < window.innerHeight && r.bottom > 0);
      })()
    `),
  );
  check("jumping to a card brings it back on-screen", cardVisibleAfterJump, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
