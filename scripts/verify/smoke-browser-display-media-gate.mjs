// Pre-release audit S2 — a page inside a BrowserCard used to get
// `getDisplayMedia()` auto-approved with the first screen source found,
// zero human confirmation, and every OTHER permission (camera, mic,
// geolocation, notifications) fell through to Electron's permissive
// default because `setPermissionRequestHandler`/`setPermissionCheckHandler`
// were never set at all. Verifies both fixes against a REAL navigated
// page's own webContents (found via its own CDP target, same pattern
// smoke-browser.mjs already established for the offscreen-rendered
// browser card), not a mock: camera access is denied outright with no
// modal at all; a screen-share request goes through TWO layered
// ConfirmModal prompts (the generic "media" one first, then a specific
// one naming the page — see main/index.ts's own comment on why
// getDisplayMedia can't skip the generic layer), denying at either layer
// makes the page's own promise reject, and approving both lets the flow
// proceed (checked as "settles, doesn't hang forever" — whether it
// ultimately resolves depends on real capturable sources existing in
// whatever display environment this runs under, which this harness
// doesn't control and shouldn't assert on).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9410;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-display-media-gate", import.meta.url).pathname;

async function connectRawTarget(cdpPort, urlSubstring) {
  const targets = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json());
  const target = targets.find((t) => t.url.includes(urlSubstring));
  if (!target) throw new Error(`no CDP target with url containing "${urlSubstring}"`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result);
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, { resolve });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  await send("Runtime.enable");
  return {
    ws,
    /** `userGesture: true` matters — Chromium requires transient user
     * activation for getDisplayMedia/getUserMedia, which a plain
     * Runtime.evaluate call otherwise lacks. */
    evalUserGesture: async (expr) => {
      const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
      return res.result?.value;
    },
    close: () => ws.close(),
  };
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page);

  const btn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.rail-btn')].find(x => x.title && x.title.toLowerCase().includes("navegador"));
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(btn.x, btn.y);
  await new Promise((r) => setTimeout(r, 1000));

  const barCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const inp = document.querySelector('.browser-card-address input');
        const r = inp.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.browser-card-address input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'https://example.com');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 2500));

  const off = await connectRawTarget(CDP_PORT, "example.com");

  // 1. Camera — denied outright by setPermissionRequestHandler, no modal
  // at all (Electron never shows its own prompt when a handler denies).
  const camResultPromise = off.evalUserGesture(
    `navigator.mediaDevices.getUserMedia({video:true}).then(s => { s.getTracks().forEach(t=>t.stop()); return 'GRANTED'; }).catch(e => 'DENIED:' + e.name)`,
  );
  await new Promise((r) => setTimeout(r, 500));
  check("camera request shows NO modal at all (denied by the permission handler, not a prompt)", await page.evalJs(`!!document.querySelector('.modal')`), false);
  const camResult = await camResultPromise;
  check("...and the page's own getUserMedia call is rejected", camResult?.startsWith("DENIED"), true);

  // Two-layer gate: every getDisplayMedia call hits the GENERIC "media"
  // permission prompt first (indistinguishable from getUserMedia at that
  // layer — see main/index.ts's own comment on this), then — only once
  // that's approved — the specific "quer capturar sua tela" one that
  // names the page. Helper clicks whichever button text is asked for on
  // whatever modal is currently showing.
  async function clickModalButton(label) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
        })()
      `),
    );
    await page.click(coords.x, coords.y);
  }

  // 2. Screen share, denied at the generic layer — the page's own promise
  // must reject and the more specific modal must never even appear.
  const share1Promise = off.evalUserGesture(
    `navigator.mediaDevices.getDisplayMedia({video:true}).then(s => { s.getTracks().forEach(t=>t.stop()); return 'GRANTED'; }).catch(e => 'DENIED:' + e.name)`,
  );
  await new Promise((r) => setTimeout(r, 500));
  const genericModalText = await page.evalJs(`document.querySelector('.modal p')?.textContent ?? null`);
  check(
    "getDisplayMedia shows the generic media-permission modal first",
    genericModalText?.includes("câmera/microfone"),
    true,
  );
  await clickModalButton("Cancelar");
  const share1Result = await share1Promise;
  check("denying the generic modal makes the page's getDisplayMedia call reject", share1Result?.startsWith("DENIED"), true);
  check("...and the modal is gone", await page.evalJs(`!document.querySelector('.modal')`), true);

  // 3. Screen share, generic layer approved this time — the specific,
  // page-naming modal must show next.
  const share2Promise = off.evalUserGesture(
    `navigator.mediaDevices.getDisplayMedia({video:true}).then(s => { s.getTracks().forEach(t=>t.stop()); return 'GRANTED'; }).catch(e => 'DENIED:' + e.name)`,
  );
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton("Permitir");
  await new Promise((r) => setTimeout(r, 500));
  const specificModalText = await page.evalJs(`document.querySelector('.modal p')?.textContent ?? null`);
  check("...then the specific modal shows next, naming the page", specificModalText?.includes("example.com"), true);

  // Deny THIS one — the page's own promise must still reject.
  await clickModalButton("Cancelar");
  const share2Result = await share2Promise;
  check("denying the specific modal makes the page's getDisplayMedia call reject", share2Result?.startsWith("DENIED"), true);
  check("...and the modal is gone", await page.evalJs(`!document.querySelector('.modal')`), true);

  // 4. Screen share once more, approving BOTH layers — must settle (not
  // hang forever), whatever the final outcome given this environment's
  // own real (or absent) capturable sources.
  const share3Promise = off.evalUserGesture(
    `navigator.mediaDevices.getDisplayMedia({video:true}).then(s => { s.getTracks().forEach(t=>t.stop()); return 'GRANTED'; }).catch(e => 'DENIED:' + e.name)`,
  );
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton("Permitir");
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton("Permitir");
  const share3Result = await Promise.race([
    share3Promise,
    new Promise((resolve) => setTimeout(() => resolve("TIMED_OUT"), 8000)),
  ]);
  check("approving both layers lets the flow proceed — it settles, doesn't hang forever", share3Result !== "TIMED_OUT", true);
  check("...and the modal is gone either way", await page.evalJs(`!document.querySelector('.modal')`), true);

  off.close();
  page.close();
} finally {
  await stopApp(app);
}
finish();
