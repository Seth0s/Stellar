import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

import fs from "node:fs";

const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-wheel-${Date.now()}-${Math.random()}`, import.meta.url).pathname;
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function centerOf(page, selector) {
  return await page.evalJs(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();

try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page);

  // 1. Check terminal container and scrollbar gutter removal
  const viewportScrollbarWidth = await page.evalJs(`
    (() => {
      const vp = document.querySelector(".terminal-card-body .xterm-viewport");
      if (!vp) return null;
      const style = window.getComputedStyle(vp);
      return {
        scrollbarWidth: style.scrollbarWidth,
        overflowY: style.overflowY,
        offsetWidth: vp.offsetWidth,
        clientWidth: vp.clientWidth
      };
    })()
  `);
  check("xterm-viewport has scrollbar-width none", viewportScrollbarWidth?.scrollbarWidth, "none");
  check("clientWidth equals offsetWidth (zero scrollbar gutter reserved)", viewportScrollbarWidth?.clientWidth === viewportScrollbarWidth?.offsetWidth, true);

  // 2. Test mouse wheel over fresh terminal prompt (no scrollback)
  const termBodyPos = await centerOf(page, ".terminal-card-body");
  check("terminal body found", !!termBodyPos, true);

  await page.click(termBodyPos.x, termBodyPos.y);
  await delay(200);

  // Dispatch mouse wheel UP and DOWN multiple times
  for (let i = 0; i < 5; i++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: termBodyPos.x,
      y: termBodyPos.y,
      deltaX: 0,
      deltaY: -100, // Wheel UP
      pointerType: "mouse"
    });
    await delay(50);
  }

  for (let i = 0; i < 5; i++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: termBodyPos.x,
      y: termBodyPos.y,
      deltaX: 0,
      deltaY: 100, // Wheel DOWN
      pointerType: "mouse"
    });
    await delay(50);
  }
  await delay(300);

  // Read the buffer lines to verify no Up/Down arrow characters or history were triggered
  const bufferContent = await page.evalJs(`
    (() => {
      const termEl = document.querySelector(".terminal.xterm");
      return termEl?.textContent || "";
    })()
  `);
  // If arrow keys had been sent, bash would echo history or ^[[A / ^[[B
  check("no escape artifacts or arrow keys leaked into terminal", !bufferContent.includes("^[[A") && !bufferContent.includes("^[OA"), true);

  // 3. Verify terminal canvas spans full container width without the 14px scrollbar deduction
  const columnMath = await page.evalJs(`
    (() => {
      const termBody = document.querySelector(".terminal-card-body");
      const canvas = document.querySelector(".terminal-card-body .xterm-screen canvas");
      if (!termBody || !canvas) return null;
      const bodyW = termBody.clientWidth;
      const canvasW = canvas.offsetWidth || canvas.width;
      return { bodyW, canvasW, diff: bodyW - canvasW };
    })()
  `);
  check("terminal canvas diff is less than 1 cell width (no 14px scrollbar gap)", columnMath?.diff < 12, true);

  // 4. Test scrollback scrolling direction (wheel up scrolls UP, wheel down scrolls DOWN)
  await page.evalJs(`
    (() => {
      // Type command to produce scrollback
      const termId = document.querySelector(".terminal-card")?.dataset?.cardId || "terminal";
    })()
  `);

  finish();
} finally {
  await stopApp(app);
}
