// Regression coverage for the offscreen-rendering rewrite of the browser
// card (2026-08-26, DESIGN-BACKLOG.md item 9) — the previous
// `WebContentsView`/`addChildView` approach never composited into the main
// window (electron/electron#45367), so the one thing worth actually
// asserting here is that the card's canvas ends up with REAL page pixels,
// not just a plausible-looking DOM tree. CDP's own `Page.captureScreenshot`
// can't see this (documented elsewhere as a structural limitation — it
// never shows native/offscreen-composited content), so this reads the
// canvas's own pixel data directly via `getImageData`, a plain DOM API with
// no such blind spot.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = 9406;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  // DESIGN-BACKLOG.md item 8 — boots to Home now; needs a real board (rail)
  // before the browser-card button exists to click.
  await bootIntoFreshSession(page);

  // Rail reorg (2.2's "menu único de Ferramentas/Cards") moved card
  // creation behind an "Adicionar card" popover for every kind but
  // terminal — `spawnCard` (cdp-client.mjs) handles both the direct-
  // button and grouped-popover shapes.
  await spawnCard(page, "browser");
  await new Promise((r) => setTimeout(r, 1000));

  const initial = JSON.parse(
    await page.evalJs(`
      (() => {
        const c = document.querySelector('[data-role="browser-body"]');
        return JSON.stringify({ exists: !!c, w: c && c.width, h: c && c.height });
      })()
    `),
  );
  check("browser card canvas mounted", initial.exists, true);
  // DESIGN-BACKLOG.md item 12, achado 3 — SPAWN_W bumped 720 → 860.
  check("canvas sized to the spawn rect", initial.w, 860);

  const barCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const inp = document.querySelector('[data-role="browser-address"] input');
        const r = inp.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('[data-role="browser-address"] input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'https://example.com');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 3000));

  const pixels = JSON.parse(
    await page.evalJs(`
      (() => {
        const c = document.querySelector('[data-role="browser-body"]');
        const ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonWhite = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 250 || data[i+1] < 250 || data[i+2] < 250) nonWhite++;
        }
        return JSON.stringify({ nonWhite, total: data.length / 4 });
      })()
    `),
  );
  // A real navigated page (Example Domain) paints a real block of dark
  // text over a mostly-white background — an all-white canvas (the old,
  // broken symptom) would read 0 here regardless of threshold.
  check("navigated page painted real (non-white) pixels", pixels.nonWhite > 1000, true);

  // Regression check: real click-to-focus-a-form-field + real typing +
  // real scroll direction, all through the actual UI path (CDP dispatches
  // on the OUTER page at the canvas's on-screen position, same as a real
  // user — not calling window.browser directly). Caught three real bugs
  // live: offscreen windows never gaining Chromium's click-to-focus state
  // (fixed with an explicit webContents.focus() on mousedown), keyDown/
  // keyUp alone never inserting text (fixed by also sending a "char"
  // event), and sendInputEvent's wheel delta sign being inverted from the
  // DOM WheelEvent it's built from (fixed by negating it).
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('[data-role="browser-address"] input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'https://duckduckgo.com/html/');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 3000));

  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  const offTarget = targets.find((t) => t.url.includes("duckduckgo"));
  const offWs = new WebSocket(offTarget.webSocketDebuggerUrl);
  await new Promise((r) => offWs.addEventListener("open", r, { once: true }));
  let offMsgId = 0;
  const offPending = new Map();
  offWs.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && offPending.has(msg.id)) {
      offPending.get(msg.id)(msg.result);
      offPending.delete(msg.id);
    }
  });
  function offSend(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++offMsgId;
      offPending.set(id, resolve);
      offWs.send(JSON.stringify({ id, method, params }));
    });
  }
  await offSend("Runtime.enable");
  async function offEval(expression) {
    const res = await offSend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return res.result.value;
  }

  // Offscreen-space input coords -> real on-screen coords, via the
  // canvas's own displayed box (same math the app itself would need to go
  // the other way in toCanvasPoint).
  const clickTarget = JSON.parse(
    await offEval(`
      (() => {
        const inp = document.querySelector('input[type="text"], input[name="q"]');
        const r = inp.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  const canvasBox = JSON.parse(
    await page.evalJs(`
      (() => {
        const c = document.querySelector('[data-role="browser-body"]');
        const r = c.getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height, cw: c.width, ch: c.height });
      })()
    `),
  );
  const screenClick = {
    x: canvasBox.left + (clickTarget.x / canvasBox.cw) * canvasBox.width,
    y: canvasBox.top + (clickTarget.y / canvasBox.ch) * canvasBox.height,
  };
  await page.click(screenClick.x, screenClick.y);
  await new Promise((r) => setTimeout(r, 400));
  const focusedAfterClick = await offEval(`document.activeElement.tagName`);
  check("clicking a real <input> on the page focuses it", focusedAfterClick, "INPUT");

  for (const ch of "hi") {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: `Key${ch.toUpperCase()}`, text: ch });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: `Key${ch.toUpperCase()}` });
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 400));
  const typedValue = await offEval("document.activeElement.value");
  check("typing reaches the embedded page's focused input", typedValue.length > 0, true);

  offWs.close();

  // Scroll direction, on a page tall enough to guarantee something to
  // scroll (duckduckgo's own results list isn't a reliable enough length).
  // A cross-origin navigation swaps the offscreen webContents' renderer
  // process (and its CDP target), so reconnect fresh rather than reuse
  // offWs/offEval above.
  // Focus is still on the canvas from the click/type checks above — move it
  // back to the address bar first, or the Enter below goes to the canvas's
  // own onKeyDown (forwarded into the page) instead of triggering navigate.
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('[data-role="browser-address"] input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'https://en.wikipedia.org/wiki/Electron_(software_framework)');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 3000));
  // Focus moved to the address bar on that click+Enter — the card's own
  // onWheel only forwards to the page while ITS canvas is focused (the
  // click-to-focus gate from the earlier zoom-interception fix), so a
  // click back onto the canvas is required before the wheel check below
  // does anything but zoom the board.
  await page.click(screenClick.x, screenClick.y);

  const wikiTargets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  const wikiTarget = wikiTargets.find((t) => t.url.includes("wikipedia"));
  if (!wikiTarget) {
    console.log("(scroll-direction check skipped — wikipedia target not found)");
  } else {
    const wikiWs = new WebSocket(wikiTarget.webSocketDebuggerUrl);
    await new Promise((r) => wikiWs.addEventListener("open", r, { once: true }));
    let wikiMsgId = 0;
    const wikiPending = new Map();
    wikiWs.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && wikiPending.has(msg.id)) {
        wikiPending.get(msg.id)(msg.result);
        wikiPending.delete(msg.id);
      }
    });
    function wikiSend(method, params = {}) {
      return new Promise((resolve) => {
        const id = ++wikiMsgId;
        wikiPending.set(id, resolve);
        wikiWs.send(JSON.stringify({ id, method, params }));
      });
    }
    await wikiSend("Runtime.enable");
    async function wikiEval(expression) {
      const res = await wikiSend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      return res.result.value;
    }
    const scrollBefore = await wikiEval("window.scrollY");
    for (let i = 0; i < 6; i++) {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: screenClick.x,
        y: screenClick.y,
        deltaX: 0,
        deltaY: 120,
      });
      await new Promise((r) => setTimeout(r, 150));
    }
    const scrollAfter = await wikiEval("window.scrollY");
    check("scrolling down over the card scrolls the embedded page down (not inverted)", scrollAfter > scrollBefore, true);
    wikiWs.close();
  }

  // Regression check: focusing the canvas + typing a tool-shortcut letter
  // ("s") used to also flip the app's global tool to "select" (App.tsx's
  // keydown listener didn't treat a focused <canvas> as "typing"), which
  // silently cut off further input forwarding and, via the flex/intrinsic-
  // size bug below, could push the card's own header out of view.
  await page.evalJs(`
    (() => { document.querySelector('[data-role="browser-body"]').focus(); })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "s", code: "KeyS", text: "s" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "s", code: "KeyS" });
  await new Promise((r) => setTimeout(r, 300));
  const afterType = JSON.parse(
    await page.evalJs(`
      (() => {
        const header = document.querySelector('[data-role="browser-address"]');
        const r = header ? header.getBoundingClientRect() : null;
        const selectBtn = [...document.querySelectorAll('.rail-btn')].find((b) => b.title?.toLowerCase().includes('sele'));
        return JSON.stringify({
          headerVisible: !!r && r.height > 0 && r.width > 0,
          toolSwitchedToSelect: !!selectBtn?.classList.contains('active'),
        });
      })()
    `),
  );
  check("header stays visible after typing a shortcut letter into the card", afterType.headerVisible, true);
  check("typing into the card doesn't flip the app's global tool", afterType.toolSwitchedToSelect, false);

  const closed = JSON.parse(
    await page.evalJs(`
      (() => {
        const btn = [...document.querySelectorAll('[data-role="browser-address"] button')].pop();
        btn.click();
        return JSON.stringify({ ok: true });
      })()
    `),
  );
  await new Promise((r) => setTimeout(r, 500));
  const gone = await page.evalJs(`JSON.stringify(!document.querySelector('[data-role="browser-body"]'))`);
  check("browser card closes cleanly", JSON.parse(gone), true);
  void closed;

  page.close();
} finally {
  await stopApp(app);
}
finish();
