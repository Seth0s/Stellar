// DESIGN-BACKLOG.md item 42 — investigation only, throwaway script (not
// meant to join the permanent smoke-*.mjs suite). Reproduces "resize the
// OS window while a terminal card is already open" and measures the
// terminal canvas's backing-store size (canvas.width/height) vs its CSS
// size * devicePixelRatio, before and after a REAL OS-level window resize.
//
// Electron's CDP renderer endpoint does NOT implement the Browser domain
// (Browser.getWindowForTarget/setWindowBounds both 404 with "wasn't
// found" — confirmed live) since Electron owns window management itself
// instead of delegating to Chromium's browser-process window manager.
// Real OS resize here instead goes through the app's MAIN process: launched
// with an extra `--inspect=<port>` flag (a Node.js debugger port, separate
// from --remote-debugging-port), then `BrowserWindow.getAllWindows()[0]
// .setBounds(...)` via that inspector's Runtime.evaluate — genuinely
// resizes the OS window, not a DOM-level emulation. Getting a handle on
// the `electron` module from a raw CDP eval needed one more workaround:
// dynamic `import("electron")` throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING
// in this context (Node's inspector doesn't wire the dynamic-import
// callback for a plain Runtime.evaluate, only for the `node inspect` CLI
// REPL) — `process.getBuiltinModule("node:module").createRequire(...)`
// sidesteps it, since Electron's `require("electron")` patch is applied at
// the process-wide Module level, reachable from a freshly created
// `require` too.
import { startApp, stopApp, connectPage, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = 9540;
const INSPECT_PORT = 9340;
const USER_DATA_DIR = new URL("../../.verify-tmp/investigate-item42", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraArgs: [`--inspect=${INSPECT_PORT}`],
});
try {
  const page = await connectPage(CDP_PORT);
  await bootIntoFreshSession(page);
  await new Promise((r) => setTimeout(r, 500));

  // Type real content into the terminal via CDP keyboard so the canvas has
  // actual rendered glyphs, not just an empty buffer.
  const bodyRect = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.terminal-card-body');
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(bodyRect.x, bodyRect.y);
  await new Promise((r) => setTimeout(r, 200));
  for (const ch of "echo hello-item42\n") {
    await page.send("Input.dispatchKeyEvent", { type: "char", text: ch });
  }
  await new Promise((r) => setTimeout(r, 500));

  async function measure(label) {
    const raw = await page.evalJs(`
      (() => {
        const container = document.querySelector('.terminal-card-body');
        if (!container) return JSON.stringify({ error: "no container" });
        const canvases = [...container.querySelectorAll('canvas')];
        const rect = container.getBoundingClientRect();
        return JSON.stringify({
          dpr: window.devicePixelRatio,
          containerCssWidth: rect.width,
          containerCssHeight: rect.height,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          rendererType: window.__stellarRendererType ?? null,
          canvases: canvases.map((c) => ({
            className: c.className || "(unnamed)",
            canvasWidth: c.width,
            canvasHeight: c.height,
            cssWidth: c.getBoundingClientRect().width,
            cssHeight: c.getBoundingClientRect().height,
          })),
        });
      })()
    `);
    const parsed = JSON.parse(raw);
    console.log(`\n--- ${label} ---`);
    console.log(JSON.stringify(parsed, null, 2));
    return parsed;
  }

  const before = await measure("BEFORE window resize");

  // --- Real OS-level window resize, via the main process's own Node
  // inspector (see file header for why not CDP's Browser domain). ---
  const inspectList = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json`)).json();
  const nodeTarget = inspectList[0];
  const iws = new WebSocket(nodeTarget.webSocketDebuggerUrl);
  await new Promise((r) => iws.addEventListener("open", r, { once: true }));
  let iid = 0;
  const iPending = new Map();
  iws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && iPending.has(msg.id)) {
      iPending.get(msg.id)(msg);
      iPending.delete(msg.id);
    }
  });
  function iSend(method, params = {}) {
    return new Promise((resolve) => {
      iid++;
      iPending.set(iid, resolve);
      iws.send(JSON.stringify({ id: iid, method, params }));
    });
  }
  await iSend("Runtime.enable");
  function wrapMain(body) {
    return `(() => {
      const mod = process.getBuiltinModule("node:module");
      const req = mod.createRequire(process.cwd() + "/x.js");
      const { BrowserWindow } = req("electron");
      ${body}
    })()`;
  }

  const boundsBeforeRes = await iSend("Runtime.evaluate", {
    expression: wrapMain("return JSON.stringify(BrowserWindow.getAllWindows().map((w) => w.getBounds()));"),
    returnByValue: true,
  });
  const boundsBefore = JSON.parse(boundsBeforeRes.result.result.value)[0];
  console.log("\nreal OS window bounds BEFORE:", JSON.stringify(boundsBefore));

  const newWidth = boundsBefore.width + 400;
  const newHeight = boundsBefore.height + 300;
  await iSend("Runtime.evaluate", {
    expression: wrapMain(`
      const w = BrowserWindow.getAllWindows()[0];
      const b = w.getBounds();
      w.setBounds({ x: b.x, y: b.y, width: ${newWidth}, height: ${newHeight} });
      return "done";
    `),
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 1000));

  const boundsAfterRes = await iSend("Runtime.evaluate", {
    expression: wrapMain("return JSON.stringify(BrowserWindow.getAllWindows().map((w) => w.getBounds()));"),
    returnByValue: true,
  });
  const boundsAfter = JSON.parse(boundsAfterRes.result.result.value)[0];
  console.log("real OS window bounds AFTER:", JSON.stringify(boundsAfter));
  iws.close();

  check("the OS window actually got wider", boundsAfter.width > boundsBefore.width, true);
  check("the OS window actually got taller", boundsAfter.height > boundsBefore.height, true);

  // Give the renderer a moment to react to the real resize (DOM reflow,
  // any resize listener/ResizeObserver if one exists).
  await new Promise((r) => setTimeout(r, 500));

  const after = await measure("AFTER window resize");

  check(
    "the terminal card's own CSS size changed as a result of the window resize (sanity: does resizing the WINDOW change the card's DOM size at all, given cards are positioned in fixed world-space rect.w/rect.h, not window-relative)",
    before.containerCssWidth !== after.containerCssWidth || before.containerCssHeight !== after.containerCssHeight,
    (v) => typeof v === "boolean",
  );

  for (let i = 0; i < before.canvases.length; i++) {
    const b = before.canvases[i];
    const a = after.canvases[i];
    if (!a) continue;
    if (b.cssWidth === 0 && b.cssHeight === 0) continue; // skip the 0x0 helper canvas xterm keeps around
    const expectedBeforeW = Math.round(b.cssWidth * before.dpr);
    const expectedAfterW = Math.round(a.cssWidth * after.dpr);
    check(
      `canvas[${i}] (${b.className}) backing-store matched CSS*dpr BEFORE resize`,
      Math.abs(b.canvasWidth - expectedBeforeW) <= 2,
      true,
    );
    check(
      `canvas[${i}] (${b.className}) backing-store matched CSS*dpr AFTER resize (the actual bug hypothesis)`,
      Math.abs(a.canvasWidth - expectedAfterW) <= 2,
      true,
    );
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
