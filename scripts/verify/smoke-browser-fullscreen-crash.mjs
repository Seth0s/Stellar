// DESIGN-BACKLOG.md item 37 — reported live: fullscreen video in an
// embedded browser card (YouTube) "opens another window that errors,
// crashes the app on close". Investigated hard before this test existed:
// 3 separate live CDP repros (minimal fullscreen, real YouTube fullscreen
// entry with the video genuinely playing and `document.fullscreenElement`
// confirmed true, and closing the card mid-fullscreen) did NOT reproduce
// a crash in an isolated instance — the exact trigger stayed unconfirmed.
// But two real, independent gaps were found reading the code regardless:
// no `setWindowOpenHandler` (any `window.open()` from an embedded page
// spawned a real, unmanaged, visible native BrowserWindow — a genuine
// "outra janela" by definition) and zero `uncaughtException`/
// `unhandledRejection` handling anywhere in main (Electron's default for
// either is to crash the WHOLE app, matching "crash no app inteiro" for
// literally any bug anywhere in main, not just this one). Both fixed;
// this proves each fix does what it claims, deterministically, without
// depending on YouTube's actual DOM/network (flaky, out of this app's
// control) the way the original live investigation had to.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9454;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-fullscreen-crash", import.meta.url).pathname;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body>
    <video id="v" style="width:200px;height:150px" muted loop autoplay></video>
    <button id="fs" onclick="v.requestFullscreen().then(()=>{document.title='FS_OK'}).catch((e)=>{document.title='FS_ERR:'+e.message})">fullscreen</button>
    <button id="popup" onclick="window.open('https://example.com', '_blank')">open popup</button>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Fullscreen Crash Teste");
  await new Promise((r) => setTimeout(r, 800));

  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  const barCoords = await centerOf(page, ".browser-card-address input");
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.browser-card-address input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'http://127.0.0.1:${port}/');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 1200));

  const targetsBefore = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  const offTarget = targetsBefore.find((t) => t.url.includes(`127.0.0.1:${port}`));
  if (!offTarget) throw new Error("offscreen target not found — navigation failed");
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
    return res?.result?.value;
  }

  // --- 1. window.open() denial ---
  const popupRect = JSON.parse(await offEval(`(() => { const r = document.getElementById('popup').getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`));
  await offSend("Input.dispatchMouseEvent", { type: "mousePressed", x: popupRect.x, y: popupRect.y, button: "left", clickCount: 1 });
  await offSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: popupRect.x, y: popupRect.y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 800));
  const targetsAfterPopup = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  check(
    "window.open() de dentro de um browser card NÃO abre outra janela real (setWindowOpenHandler nega)",
    targetsAfterPopup.length,
    targetsBefore.length,
  );

  // --- 2. HTML fullscreen doesn't crash/hang, and the page's own API
  // still resolves normally (the fix only stops the HOST window from
  // syncing, not the page's fullscreen state itself) ---
  const fsRect = JSON.parse(await offEval(`(() => { const r = document.getElementById('fs').getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()`));
  await offSend("Input.dispatchMouseEvent", { type: "mousePressed", x: fsRect.x, y: fsRect.y, button: "left", clickCount: 1 });
  await offSend("Input.dispatchMouseEvent", { type: "mouseReleased", x: fsRect.x, y: fsRect.y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 800));
  check("requestFullscreen() dentro do card ainda resolve normalmente pro código da própria página", await offEval("document.title"), "FS_OK");
  check("...e a app continua respondendo depois (não travou nem crashou)", await page.evalJs("1+1"), 2);

  // --- 3. Crash-safety net: a real uncaught exception in main does NOT
  // take the whole app down anymore ---
  await page.evalJs("window.debugBridge.testTriggerUncaughtException()");
  await new Promise((r) => setTimeout(r, 600));
  check(
    "uma exceção não-tratada real no processo main NÃO derruba o app inteiro (crash-safety net)",
    await page.evalJs("1+1"),
    2,
  );
  const targetsAfterCrashTrigger = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  check("...e a janela principal continua listada de verdade no CDP (processo genuinamente vivo)", targetsAfterCrashTrigger.length >= 2, true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
