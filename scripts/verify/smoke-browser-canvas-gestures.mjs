// Canvas gestures over a browser card.
//
// The owner's report: with the pointer over a browser card the wheel and the drag
// of the canvas stop at the page, so there is no way to move around the board from
// there. The rule under test (canvas-gesture-decision.ts), measured on a real card:
//   - plain wheel over the card scrolls the PAGE and the canvas does not zoom;
//   - Ctrl/Cmd + wheel over the card zooms the CANVAS and the page does not scroll;
//   - Ctrl/Cmd + drag (page, bar or border) and a middle-button drag pan the canvas
//     and the page sees no click;
//   - a plain drag on the bar still moves the card and a plain drag on the page
//     still reaches the page.
// Isolated userData and port; the page is served from a local http server.
import { createServer } from "node:http";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-canvas-gestures-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const CTRL = 2; // CDP modifier bit

const PAGE = `<body style="margin:0"><div style="height:6000px;background:linear-gradient(#fff,#468)"></div>
<script>window.__downs=0;window.__wheels=0;addEventListener('mousedown',()=>window.__downs++);addEventListener('wheel',()=>window.__wheels++,{passive:true})</script></body>`;
const httpPort = await pickFreePort();
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(httpPort, "127.0.0.1", r));

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Canvas Gestures");
  await delay(600);

  const center = async (sel) =>
    JSON.parse(await page.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return JSON.stringify(null); const r = e.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,top:r.top,right:r.right,bottom:r.bottom}); })()`));
  const add = await center('[data-role="rail-add-card"]');
  await page.click(add.x, add.y);
  await delay(300);
  const btn = await center('.popover-row[data-kind="browser"]');
  await page.click(btn.x, btn.y);
  await delay(800);
  const boardId = await page.evalJs(`(async () => (await window.store.boards.list()).find((b) => b.name === "Canvas Gestures")?.id ?? null)()`);
  const cardId = JSON.parse(await page.evalJs(`(async () => JSON.stringify((await window.store.list(${JSON.stringify(boardId)})).filter((c) => c.kind === "browser").map((c) => c.id)))()`))[0];
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, "http://127.0.0.1:${httpPort}/")`);
  await delay(1500);

  const world = async () =>
    JSON.parse(await page.evalJs(`(() => { const m = new DOMMatrix(getComputedStyle(document.querySelector('.world')).transform); return JSON.stringify({ x: m.e, y: m.f, zoom: m.a }); })()`));
  const cardRect = async () => center('[data-kind="browser"].card-frame, .card-frame[data-kind="browser"]');
  const pageState = async () => {
    // The page's own value is a JSON string; `evalJs` returns it JSON-encoded again.
    const raw = await page.evalJs(`window.browser.evalJs(${JSON.stringify(cardId)}, "JSON.stringify({y: window.scrollY, downs: window.__downs, wheels: window.__wheels})").then((r) => (r.ok ? r.result : "null"))`);
    return JSON.parse(JSON.parse(raw));
  };

  // A point inside the page canvas that is also inside the window.
  const body = await page.evalJs(`(() => { const r = document.querySelector('[data-role="browser-body"]').getBoundingClientRect(); const l=Math.max(r.left,0), t=Math.max(r.top,0), rr=Math.min(r.right,innerWidth), b=Math.min(r.bottom,innerHeight); return JSON.stringify({x:(l+rr)/2, y:(t+b)/2}); })()`).then(JSON.parse);
  check("o ponto de teste está sobre o canvas do navegador", await page.evalJs(`document.querySelector('[data-role="browser-body"]').contains(document.elementFromPoint(${body.x}, ${body.y}))`), true);
  await page.click(body.x, body.y); // real click: gives the canvas keyboard focus, so plain wheel reaches the page
  await delay(400);

  const wheel = (x, y, deltaY, modifiers = 0) => page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers });

  // --- wheel ---
  const w0 = await world();
  const p0 = await pageState();
  for (let i = 0; i < 4; i++) { await wheel(body.x, body.y, 120); await delay(80); }
  await delay(500);
  const w1 = await world();
  const p1 = await pageState();
  check("roda simples sobre o card ROLA A PÁGINA", p1.y > p0.y, true);
  check("roda simples sobre o card NÃO dá zoom no canvas", Math.abs(w1.zoom - w0.zoom) < 1e-6, true);

  for (let i = 0; i < 4; i++) { await wheel(body.x, body.y, -120, CTRL); await delay(80); }
  await delay(500);
  const w2 = await world();
  const p2 = await pageState();
  check("Ctrl+roda sobre o card DÁ ZOOM NO CANVAS", w2.zoom > w1.zoom + 0.05, true);
  check("Ctrl+roda sobre o card NÃO rola a página", p2.y === p1.y && p2.wheels === p1.wheels, true);

  // --- drag with Ctrl over the page ---
  const drag = async (from, to, { button = "left", modifiers = 0 } = {}) => {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", modifiers });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button, clickCount: 1, modifiers });
    for (let i = 1; i <= 6; i++) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6, button, buttons: button === "middle" ? 4 : 1, modifiers });
      await delay(20);
    }
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button, clickCount: 1, modifiers });
    await delay(300);
  };
  const dx = -90, dy = 40;
  const a0 = await world();
  const c0 = await cardRect();
  const pa = await pageState();
  await drag(body, { x: body.x + dx, y: body.y + dy }, { modifiers: CTRL });
  const a1 = await world();
  const c1 = await cardRect();
  const pb = await pageState();
  check("Ctrl+arrastar sobre a PÁGINA move o canvas (a mesma distância)", Math.abs(a1.x - a0.x - dx) < 3 && Math.abs(a1.y - a0.y - dy) < 3, true);
  check("...e a página não recebeu clique nenhum", pb.downs === pa.downs, true);
  check("...e o card não se moveu em relação à tela de forma própria (só o canvas andou)", Math.abs(c1.x - c0.x - dx) < 3 && Math.abs(c1.y - c0.y - dy) < 3, true);

  // --- middle button drag over the page ---
  const b0 = await world();
  await drag(c1, { x: c1.x + 60, y: c1.y + 30 }, { button: "middle" });
  const b1 = await world();
  check("botão do meio arrastando sobre a página move o canvas", Math.abs(b1.x - b0.x - 60) < 3 && Math.abs(b1.y - b0.y - 30) < 3, true);

  // --- the bar: with Ctrl pans the canvas, without it moves the card ---
  // The zoom-in above pushed the bar off the top of the window: pan the canvas down
  // with the same gesture under test until the bar is on screen.
  const headPointNow = async () =>
    JSON.parse(await page.evalJs(`(() => {
      const h = document.querySelector('.card-frame[data-kind="browser"] .card-head');
      const r = h.getBoundingClientRect();
      const l = Math.max(r.left, 0), rr = Math.min(r.right, innerWidth);
      const x = l + (rr - l) * 0.3, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return JSON.stringify(hit && h.contains(hit) ? { x, y } : null);
    })()`));
  for (let i = 0; i < 4 && !(await headPointNow()); i++) {
    await drag({ x: body.x, y: Math.max(body.y - 100, 120) }, { x: body.x, y: Math.max(body.y - 100, 120) + 260 }, { modifiers: CTRL });
  }
  const headPoint = await headPointNow();
  check("a barra do card está na tela para o teste", !!headPoint, true);
  const h0 = await world();
  const hc0 = await cardRect();
  await drag(headPoint, { x: headPoint.x + 50, y: headPoint.y + 20 }, { modifiers: CTRL });
  const h1 = await world();
  const hc1 = await cardRect();
  check("Ctrl+arrastar a BARRA do card move o canvas", Math.abs(h1.x - h0.x - 50) < 3 && Math.abs(h1.y - h0.y - 20) < 3, true);
  check("...e o card não foi arrastado por si só (continua no mesmo lugar do mundo)", Math.abs(hc1.x - hc0.x - 50) < 3, true);

  const g0 = await world();
  const gc0 = await cardRect();
  await drag(headPoint, { x: headPoint.x + 50, y: headPoint.y + 20 });
  const g1 = await world();
  const gc1 = await cardRect();
  check("arrastar a barra SEM modificador continua movendo o CARD", Math.abs(gc1.x - gc0.x - 50) < 3 && Math.abs(gc1.y - gc0.y - 20) < 3, true);
  check("...e o canvas não andou", Math.abs(g1.x - g0.x) < 1 && Math.abs(g1.y - g0.y) < 1, true);

  // --- a plain drag over the page still reaches the page ---
  const body2 = await page.evalJs(`(() => { const r = document.querySelector('[data-role="browser-body"]').getBoundingClientRect(); const l=Math.max(r.left,0), t=Math.max(r.top,0), rr=Math.min(r.right,innerWidth), b=Math.min(r.bottom,innerHeight); return JSON.stringify({x:(l+rr)/2, y:(t+b)/2}); })()`).then(JSON.parse);
  const k0 = await world();
  const pk0 = await pageState();
  await drag(body2, { x: body2.x - 30, y: body2.y + 10 });
  const k1 = await world();
  const pk1 = await pageState();
  check("arrastar sobre a página SEM modificador chega na página", pk1.downs === pk0.downs + 1, true);
  check("...e o canvas não andou", Math.abs(k1.x - k0.x) < 1 && Math.abs(k1.y - k0.y) < 1, true);

  page.close();
} finally {
  server.close();
  await stopApp(app);
}
finish();
