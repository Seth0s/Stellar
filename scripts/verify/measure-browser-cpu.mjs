// MEASUREMENT (not a pass/fail smoke): CPU of an isolated Stellar instance with five
// browser cards — real pages, four animated in different ways and one static — in the
// three states that matter: (A) all on screen, (B) panned so none is on screen, and
// (C) on screen with focus on a terminal. CPU is read per process from /proc (utime +
// stime over a fixed window) for the whole process tree of the instance: the main
// process, the GPU process, every renderer. Per-card numbers also come from
// `window.browser.getProcessStats` (Electron's own metric of each card's renderer).
// Usage: node scripts/verify/measure-browser-cpu.mjs [label]
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { startApp, stopApp, connectPage, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const LABEL = process.argv[2] ?? "run";
const WINDOW_MS = 12_000;
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/measure-browser-cpu-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TICKS = 100; // sysconf(_SC_CLK_TCK) on Linux

const PAGES = {
  "/css": `<style>body{margin:0;background:#101820}.b{position:absolute;width:60px;height:60px;border-radius:50%;background:linear-gradient(45deg,#f0a,#0af);animation:m 2s linear infinite}
@keyframes m{from{transform:translateX(0) rotate(0)}to{transform:translateX(500px) rotate(360deg)}}</style>${Array.from({ length: 12 }, (_, i) => `<div class=b style="top:${i * 40}px;animation-delay:-${i * 0.2}s"></div>`).join("")}`,
  "/canvas": `<canvas id=c width=600 height=400></canvas><script>const c=document.getElementById('c'),x=c.getContext('2d');let t=0;
(function f(){t+=.02;x.clearRect(0,0,600,400);for(let i=0;i<400;i++){x.fillStyle='hsl('+((i*7+t*60)%360)+',80%,60%)';x.fillRect(300+Math.cos(t+i*.1)*i*.7,200+Math.sin(t*1.3+i*.1)*i*.45,6,6)}requestAnimationFrame(f)})()</script>`,
  "/timers": `<div id=o style="font:14px monospace"></div><script>let n=0;setInterval(()=>{n++;let s='';for(let i=0;i<300;i++)s+=(Math.sin(n+i)*1e3|0)+' ';document.getElementById('o').textContent=s},16)</script>`,
  "/css2": `<style>body{margin:0;background:#201018}.s{position:absolute;left:50%;top:50%;width:200px;height:200px;margin:-100px;border:8px solid #fa0;animation:r 3s ease-in-out infinite}
@keyframes r{50%{transform:scale(2) rotate(180deg);border-radius:50%}}</style><div class=s></div><div class=s style="animation-delay:-1s;border-color:#0af"></div>`,
  "/static": `<body style="font:16px sans-serif;padding:24px"><h1>Static page</h1><p>Nothing here moves.</p></body>`,
};
const httpPort = await pickFreePort();
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGES[req.url] ?? PAGES["/static"]);
});
await new Promise((r) => server.listen(httpPort, "127.0.0.1", r));

function procTable() {
  const rows = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const f = stat.slice(close + 2).split(" ");
      // Chromium rewrites argv of its children, so match on the whole command line.
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8");
      const type = cmd.match(/--type=([\w-]+)/)?.[1] ?? "main";
      rows.set(Number(name), { pid: Number(name), ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), type });
    } catch {
      /* process gone */
    }
  }
  return rows;
}
function treeOf(rootPid, table) {
  const out = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of table.values()) if (!out.has(r.pid) && out.has(r.ppid)) (out.add(r.pid), (grew = true));
  }
  return out;
}
let cardIdsForStats = [];
const pageNames = Object.keys(PAGES);
const statsOf = async (page, id) => JSON.parse(await page.evalJs(`window.browser.getProcessStats(${JSON.stringify(id)}).then(JSON.stringify)`));
async function sample(app, label, page) {
  // Electron's per-process metric is "since the previous call": prime it, then read it after the window.
  if (page) for (const id of cardIdsForStats) await statsOf(page, id);
  const t0 = procTable();
  const tree0 = treeOf(app.proc.pid, t0);
  if (process.env.MEASURE_DEBUG) {
    console.log("root pid", app.proc.pid, "tree", tree0.size, "table", t0.size);
    for (const r of t0.values()) if (r.type !== "main" || tree0.has(r.pid)) console.log("  ", r.pid, "ppid", r.ppid, r.type, tree0.has(r.pid) ? "IN" : "out");
  }
  const start = Date.now();
  await delay(WINDOW_MS);
  const t1 = procTable();
  const secs = (Date.now() - start) / 1000;
  const rows = [];
  for (const pid of tree0) {
    const a = t0.get(pid);
    const b = t1.get(pid);
    if (!a || !b) continue;
    rows.push({ pid, type: b.type, cpu: ((b.ticks - a.ticks) / TICKS / secs) * 100 });
  }
  let perCard = "";
  if (page) {
    const stats = [];
    for (const id of cardIdsForStats) stats.push(await statsOf(page, id));
    perCard = "  per-card(" + pageNames.map((n, i) => n.slice(1)).join("/") + ")=" + stats.map((x) => (x.ok ? x.cpuPercent.toFixed(0) : "?")).join("/") + "%";
  }
  const sum = (type) => rows.filter((r) => r.type === type).reduce((s, r) => s + r.cpu, 0);
  const renderers = rows.filter((r) => r.type === "renderer").sort((x, y) => y.cpu - x.cpu);
  const total = rows.reduce((s, r) => s + r.cpu, 0);
  console.log(
    `[${LABEL}] ${label}: total=${total.toFixed(0)}%  main=${sum("main").toFixed(0)}%  gpu=${sum("gpu-process").toFixed(0)}%  ` +
      `renderers=${renderers.map((r) => r.cpu.toFixed(0)).join("/")}%  (percent of ONE core, ${secs.toFixed(0)}s window)` + perCard,
  );
  return { total, main: sum("main"), gpu: sum("gpu-process"), renderers: renderers.map((r) => r.cpu) };
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Browser CPU");
  await delay(800);
  await sample(app, "baseline (no browser card)");

  const center = async (sel) =>
    JSON.parse(await page.evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return JSON.stringify(null); const r = e.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
  // Zoom the board out first, so every card created next stays on screen.
  const zoomOut = await center('button[aria-label="Diminuir zoom"], button[aria-label="Zoom out"]');
  for (let i = 0; i < 12; i++) {
    await page.click(zoomOut.x, zoomOut.y);
    await delay(100);
  }
  const boardId = await page.evalJs(`(async () => (await window.store.boards.list()).find((b) => b.name === "Browser CPU")?.id ?? null)()`);
  const browserIds = async () =>
    JSON.parse(await page.evalJs(`(async () => JSON.stringify((await window.store.list(${JSON.stringify(boardId)})).filter((c) => c.kind === "browser").map((c) => c.id)))()`));
  for (const path of Object.keys(PAGES)) {
    const add = await center('[data-role="rail-add-card"]');
    await page.click(add.x, add.y);
    await delay(300);
    const btn = await center('.popover-row[data-kind="browser"]');
    await page.click(btn.x, btn.y);
    await delay(700);
    const all = await browserIds();
    await page.evalJs(`window.browser.navigate(${JSON.stringify(all[all.length - 1])}, "http://127.0.0.1:${httpPort}${path}")`);
    await delay(600);
  }
  const cardIds = await browserIds();
  console.log(`[${LABEL}] browser cards: ${cardIds.length}`);
  cardIdsForStats = cardIds;
  // A point on the empty background (the viewport element itself), to pan from.
  const emptyPoint = async () =>
    JSON.parse(
      await page.evalJs(`(() => {
        const vp = document.querySelector('.viewport');
        for (let y = 100; y < innerHeight - 10; y += 20)
          for (let x = 100; x < innerWidth - 10; x += 20)
            if (document.elementFromPoint(x, y) === vp) return JSON.stringify({ x, y });
        return JSON.stringify(null);
      })()`),
    );
  await delay(3000);

  const visibleNow = () =>
    page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="browser-body"]')].map(e => { const r=e.getBoundingClientRect(); return r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight; }))`);
  console.log(`[${LABEL}] on screen (A):`, await visibleNow());
  const idle = (await emptyPoint()) ?? { x: 700, y: 120 };
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: idle.x, y: idle.y, button: "none" });
  await delay(4000); // let any focus grace period run out
  const A = await sample(app, "A) five browser cards on screen, pointer on the empty background", page);
  // A2: the pointer over one card (the one being used) — it must stay at the full rate.
  const over = JSON.parse(await page.evalJs(`(() => { const r = document.querySelectorAll('[data-role="browser-body"]')[1].getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: over.x, y: over.y, button: "none" });
  await delay(1500);
  const A2 = await sample(app, "A2) same, pointer over the animated canvas card", page);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: idle.x, y: idle.y, button: "none" });
  await delay(4000);

  // Pan the canvas far away so no browser card is in the viewport.
  for (let i = 0; i < 14; i++) {
    const bg = (await emptyPoint()) ?? { x: 700, y: 120 };
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bg.x, y: bg.y, button: "none" });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: bg.x, y: bg.y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bg.x + 400, y: bg.y, button: "left" });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bg.x + 400, y: bg.y, button: "left", clickCount: 1 });
  }
  await delay(2500);
  console.log(`[${LABEL}] on screen (B):`, await visibleNow());
  const B = await sample(app, "B) panned away, none on screen", page);
  console.log(`[${LABEL}] RESULT ${JSON.stringify({ A, A2, B })}`);
} finally {
  server.close();
  await stopApp(app);
}
