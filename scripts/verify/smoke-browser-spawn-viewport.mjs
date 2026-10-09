// Browser card: the layout viewport matches the canvas on spawn and after a
// real resize, header actions stay inside the card, and dragging the card
// does not resize or recapture the offscreen window.
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, pickFreePort, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-spawn-viewport-${CDP_PORT}`, import.meta.url).pathname;
const SHOT_DIR = new URL("../../.verify-tmp/browser-spawn-viewport/", import.meta.url).pathname;
mkdirSync(SHOT_DIR, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  // Fixed document, shorter than a 2× viewport and taller than the card
  // body. A viewport that matches the card is filled by this box; a
  // viewport at the device buffer leaves the html background below it.
  res.end(`<!doctype html><html><body style="margin:0;background:#05060a">
    <div style="height:980px;background:#05060a"></div>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { check, finish } = makeChecker();
let app;
try {
  app = await startApp({
    cdpPort: CDP_PORT,
    userDataDir: USER_DATA_DIR,
    extraArgs: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
  });
  const page = await connectPage(CDP_PORT);
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await bootIntoFreshSession(page, "Browser viewport", { spawnTerminal: false });
  await page.evalJs(`(() => { window.__frames = 0; window.browser.onFrame(() => { window.__frames++; }); return true; })()`);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((boards) => {
    const board = boards.find((item) => item.name === "Browser viewport") ?? boards[0];
    return JSON.stringify(board.id);
  })`));
  await page.evalJs(`window.store.upsert({
    id: "bview",
    board_id: ${JSON.stringify(boardId)},
    kind: "browser",
    provider: "owner",
    cwd: ${JSON.stringify(url)},
    x: 40, y: 24, w: 1100, h: 760,
    resume_id: null, model: null, effort: null, system_prompt: null,
    group_id: null, label: null,
    updated_at: Date.now(),
  }).then(() => true)`);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await wait(100);
  }
  await page.evalJs(`[...document.querySelectorAll(".home-session-name")].find((el) => el.textContent.includes("Browser viewport"))?.click()`);

  async function measure() {
    const dom = JSON.parse(await page.evalJs(`(() => {
      const card = document.querySelector('.card-frame[data-kind="browser"]');
      const canvas = card?.querySelector('[data-role="browser-body"]');
      const close = card?.querySelector('[data-role="browser-address"] button:last-child');
      const foot = card?.querySelector(".card-foot");
      if (!card || !canvas) return JSON.stringify(null);
      const cr = card.getBoundingClientRect();
      const xr = close?.getBoundingClientRect();
      let bottom = null;
      if (canvas.width > 0 && canvas.height > 0) {
        const px = canvas.getContext("2d").getImageData(Math.floor(canvas.width / 2), canvas.height - 4, 1, 1).data;
        bottom = [px[0], px[1], px[2]];
      }
      const inner = card.querySelector(".card-head-inner");
      const innerCss = inner ? getComputedStyle(inner) : null;
      const headKids = [...card.querySelectorAll(".card-head > *")].map((el) => {
        const r = el.getBoundingClientRect();
        return { c: el.className, w: Math.round(r.width), r: Math.round(r.right) };
      });
      const address = card.querySelector("[data-role='browser-address']");
      const addressCss = address ? getComputedStyle(address) : null;
      return JSON.stringify({
        canvas: { w: canvas.clientWidth, h: canvas.clientHeight, attrW: canvas.width, attrH: canvas.height },
        cardRight: cr.right,
        closeRight: xr ? xr.right : null,
        closeW: xr ? xr.width : 0,
        foot: foot?.textContent ?? "",
        bottom,
        headKids,
        innerFlex: innerCss ? { flex: innerCss.flex, max: innerCss.maxWidth, min: innerCss.minWidth } : null,
        address: address ? { w: Math.round(address.getBoundingClientRect().width), flex: addressCss.flex, display: addressCss.display } : null,
      });
    })()`));
    const pageRaw = await page.evalJs(`window.browser.evalJs("bview", "JSON.stringify({w:innerWidth,h:innerHeight})").then((r) => r.ok ? r.result : null)`);
    const content = JSON.parse(await page.evalJs(`window.debugBridge.browserContentSize("bview").then((r) => JSON.stringify(r))`));
    let pageSize = null;
    if (pageRaw) {
      const once = JSON.parse(pageRaw);
      pageSize = typeof once === "string" ? JSON.parse(once) : once;
    }
    return { dom, pageSize, content };
  }

  let snap = null;
  for (let i = 0; i < 40; i++) {
    snap = await measure();
    if (snap.dom?.canvas?.attrW > 0 && snap.pageSize) break;
    await wait(200);
  }
  await wait(1500);
  snap = await measure();
  console.log("SPAWN", JSON.stringify(snap));
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${SHOT_DIR}spawn.png`, Buffer.from(data, "base64"));

  const canvas = snap.dom?.canvas;
  const pageSize = snap.pageSize;
  check("canvas has a body box", !!canvas && canvas.w > 400 && canvas.h > 400, true);
  check(
    "layout viewport matches the canvas, not the device buffer",
    !!pageSize && Math.abs(pageSize.w - canvas.w) <= 4 && Math.abs(pageSize.h - canvas.h) <= 4,
    true,
  );
  const bottom = snap.dom?.bottom;
  check(
    "footer reports that same viewport",
    !!pageSize && snap.dom.foot.includes(`${pageSize.w} ×`) && snap.dom.foot.includes(String(pageSize.h)),
    true,
  );
  check("bottom of the card is the page, not the blank window", !!bottom && Math.max(...bottom) < 40, true);
  check("close button sits inside the card", snap.dom.closeW > 0 && snap.dom.closeRight <= snap.dom.cardRight + 1, true);
  check("zoom factor is the density cap", Math.abs((snap.content?.zoomFactor ?? 0) - 2) < 0.05, true);

  const edge = JSON.parse(await page.evalJs(`(() => {
    const r = document.querySelector('.card-frame[data-kind="browser"]')?.getBoundingClientRect();
    return JSON.stringify(r ? { x: r.x + r.width / 2, y: r.bottom - 2 } : null);
  })()`));
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: edge.x, y: edge.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: edge.x, y: edge.y - 140, button: "left", buttons: 1, pointerType: "mouse" });
  await wait(40);
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: edge.x, y: edge.y - 140, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  let resized = null;
  for (let i = 0; i < 20; i++) {
    await wait(100);
    resized = await measure();
    if (resized.dom && canvas && resized.dom.canvas.h < canvas.h - 40) break;
  }
  console.log("RESIZED", JSON.stringify(resized));
  check("resize shrinks the canvas", resized.dom.canvas.h < canvas.h - 40, true);
  check(
    "layout viewport follows the resize",
    Math.abs(resized.pageSize.h - resized.dom.canvas.h) <= 4 && Math.abs(resized.pageSize.w - resized.dom.canvas.w) <= 4,
    true,
  );

  const beforeDrag = resized.content;
  const frames0 = Number(await page.evalJs(`window.__frames`));
  await page.evalJs(`(() => {
    window.__deltas = [];
    let last = performance.now();
    const loop = (t) => { window.__deltas.push(t - last); last = t; window.__raf = requestAnimationFrame(loop); };
    window.__raf = requestAnimationFrame(loop);
    return true;
  })()`);
  const start = JSON.parse(await page.evalJs(`(() => {
    const el = document.querySelector('.card-frame[data-kind="browser"] .card-head-spacer');
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width });
  })()`));
  const t0 = Date.now();
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  for (let i = 1; i <= 12; i++) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + i * 16, y: start.y, button: "left", buttons: 1, pointerType: "mouse" });
    await wait(16);
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + 192, y: start.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  const dragMs = Date.now() - t0;
  await wait(200);
  const afterDrag = JSON.parse(await page.evalJs(`window.debugBridge.browserContentSize("bview").then((r) => JSON.stringify(r))`));
  const frames = JSON.parse(await page.evalJs(`(() => {
    cancelAnimationFrame(window.__raf);
    const d = (window.__deltas || []).slice(1);
    d.sort((a, b) => a - b);
    const p = (q) => d.length ? d[Math.min(d.length - 1, Math.floor(d.length * q))] : null;
    return JSON.stringify({ n: d.length, p50: p(0.5), p95: p(0.95), paints: window.__frames - ${frames0} });
  })()`));
  console.log("DRAG", dragMs, JSON.stringify(frames), "content", JSON.stringify(beforeDrag), "->", JSON.stringify(afterDrag));
  check("drag does not resize the offscreen window", afterDrag.w === beforeDrag.w && afterDrag.h === beforeDrag.h, true);
  check("drag of a static page does not recapture a frame per move", frames.paints < 8, true);
  check("drag frame time stays under a frame budget", frames.p95 != null && frames.p95 < 50, true);
} finally {
  if (app) await stopApp(app);
  server.close();
}
finish();
