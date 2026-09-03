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
        const cards = [...document.querySelectorAll('[data-kind="terminal"] .card-tag')].map((t) => t.textContent.trim());
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
        const tag = document.querySelector('[data-kind="terminal"] .card-tag');
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
    await page.evalJs(`JSON.stringify(document.querySelector('[data-kind="terminal"]').closest('.card-frame').getBoundingClientRect())`),
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
  // The mouseReleased used to land at (-1500,-1500) — outside the
  // viewport. Found live: `Input.dispatchMouseEvent` at coordinates
  // outside the viewport is a no-op (same finding documented below at the
  // focus-button check), so that pointerup never actually reached the
  // page — leaving the pan's window-level pointer-capture stuck "still
  // down" and swallowing the next real click (the "Localizar card" rail
  // button just below). Same delta (1200,750), but the release now lands
  // at (0,0) — still inside the viewport, still far enough to push both
  // cards fully off-screen — so the pointerup actually fires.
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1200, y: 750, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "left", clickCount: 1, pointerType: "mouse" });
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

  // DESIGN-BACKLOG.md item 21, ponto 2 — "ajustar à tela" moved from a
  // global Topbar button (confused for the real fullscreen one next to
  // it) to a per-card `.card-focus-btn` in CardFrame.tsx's header, always
  // present. Confirms it's really wired to focusCard, not just present.
  //
  // Panning fully off-screen (like the "localizar card" check above) would
  // make the button itself unclickable via synthetic CDP mouse events —
  // Chrome doesn't hit-test coordinates outside the viewport, so a button
  // that's 100% off-screen can never be the thing you click to bring it
  // back (confirmed empirically: `getBoundingClientRect()` still reports
  // negative coords, but `Input.dispatchMouseEvent` at those coords is a
  // no-op). That's fine functionally — this button lives on the card
  // itself, so it only needs to work while at least its header is partly
  // reachable; "localizar card" already covers the fully-off-screen case.
  // Pan by a smaller, horizontal-only delta instead: the card ends up
  // mostly off the left edge (not fully visible/framed) while its header
  // — and the focus button on it — stays on-screen.
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1200, y: 750, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 750, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 750, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));
  // zoomOut, zoom-readout, zoomIn, fullscreen-toggle, bgStyle, remote — the
  // old onFit button made it 7; this confirms it's really gone, not just
  // moved and left an orphan behind.
  check("no global 'ajustar à tela' button left in the zoom-pill", await page.evalJs(`document.querySelectorAll('.zoom-pill button').length`), 6);
  const notFullyVisibleBeforeFocusBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame');
        const r = el.getBoundingClientRect();
        return JSON.stringify(r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight);
      })()
    `),
  );
  check("pan leaves the card only partly framed (sanity check)", notFullyVisibleBeforeFocusBtn, true);
  const focusBtnCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.card-frame .card-focus-btn');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(focusBtnCoords.x, focusBtnCoords.y);
  await new Promise((r) => setTimeout(r, 500));
  const fullyVisibleAfterFocusBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame');
        const r = el.getBoundingClientRect();
        return JSON.stringify(r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1);
      })()
    `),
  );
  check("clicking a card's own focus button frames it fully on-screen", fullyVisibleAfterFocusBtn, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
