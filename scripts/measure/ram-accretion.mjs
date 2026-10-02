#!/usr/bin/env node
/**
 * ACÚMULO DE RAM do board — VAZAMENTO × CUSTO (task d752b50c).
 *
 * O board vivo tem renderer ~373 MB / gpu ~379 MB, e nenhuma medição anterior
 * explica isso por "N cards parados" (card ocioso ~0; WebGL RAM-neutro;
 * scrollback 4,6 MB/card). Ou é VAZAMENTO (cresce sem N mudar) ou CUSTO
 * ACUMULADO (estável, de sessão longa). Consertos diferentes — a distinção vem
 * só da MEDIÇÃO.
 *
 * Este probe NÃO conserta nada. Ele:
 *   (1) amostra RSS (renderer/gpu/main, da árvore de /proc) + `JSHeapUsedSize`
 *       (CDP) + DOM (nós/listeners/xterms) AO LONGO DO TEMPO com N FIXO;
 *       antes de cada amostra força GC (`HeapProfiler.collectGarbage`) — o que
 *       sobra DEPOIS do GC é RETIDO; se cresce com N fixo, é vazamento;
 *   (2) faz um ciclo ABRIR/FECHAR cards e vê se volta ao baseline.
 *
 * Uso: node scripts/measure/ram-accretion.mjs --cards 3 --minutes 3 --interval 10 --cycle 4
 */
import { startApp, stopApp, connectPage, pickFreePort, bootIntoFreshSession } from "../verify/cdp-client.mjs";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : process.argv[i + 1] ?? d;
};
const CARDS = Number(arg("--cards", "3"));
const MINUTES = Number(arg("--minutes", "3"));
const INTERVAL = Number(arg("--interval", "10"));
const CYCLE = Number(arg("--cycle", "4"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tamanho de página (x86_64 Linux) — só o FALLBACK do parser usa. */
const PAGE_SIZE_BYTES = 4096;

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/ram-accretion-${CDP_PORT}`, import.meta.url).pathname;

function readProc(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const f = stat.slice(close + 2).split(" ");
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const m = /--type=([a-z-]+)/.exec(cmdline);
    const type = m ? m[1] : cmdline.includes("out/main/index.js") ? "electron-main" : "cli";
    // CORREÇÃO (review R8): `f[21]` (campo 24 de /proc/<pid>/stat) é em
    // PÁGINAS — `f[21]/1024` dava ~4× MENOS. Lê `VmRSS` de /proc/<pid>/status.
    let rssKb = null;
    try {
      const sm = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (sm) rssKb = Number(sm[1]);
    } catch {}
    if (rssKb === null) rssKb = Number(f[21]) * (PAGE_SIZE_BYTES / 1024);
    return { rssKb, type };
  } catch {
    return null;
  }
}
function treePids(root) {
  const byParent = new Map();
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(Number(e));
    } catch {}
  }
  const out = [];
  const walk = (p) => {
    for (const c of byParent.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, timeoutMs: 60_000 });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "RAM Accretion", { spawnTerminal: false });
  await delay(500);

  const centerOf = (sel) =>
    page.evalJs(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);

  async function spawnTerminal() {
    const add = await centerOf('[data-role="rail-add-card"]');
    await page.click(add.x, add.y);
    await delay(250);
    const opt = await centerOf('.popover-row[data-kind="terminal"]');
    if (!opt) throw new Error("opcao Terminal nao encontrada");
    await page.click(opt.x, opt.y);
    await delay(250);
    const create = await centerOf(".popover-actions button.primary");
    if (create) await page.click(create.x, create.y);
    await delay(900);
  }
  const terminalIds = () =>
    page.evalJs(`
      (async () => { const b = await window.store.boards.list(); const cs = await window.store.list(b[0].id);
        const out = {}; for (const c of cs) out[c.id] = { kind: c.kind, cli: window.__getTerminalDims?.(c.id) ? 1 : 0 }; return out; })()
    `);

  // Fecha um card terminal clicando o ÚLTIMO botão do header dele (o close).
  async function closeCard(id) {
    // Clique REAL (CDP) nas coordenadas do botão de fechar — o `.click()` de
    // DOM não fechou (medido); e o alvo é o último botão de card-head-inner, não
    // de card-head (o CardFrame acrescenta o botão de FOCO depois dele).
    const coords = await page.evalJs(`
      (() => {
        const marker = document.querySelector('[data-card-id="' + ${JSON.stringify(id)} + '"]');
        if (!marker) return null;
        // [data-card-id] é um MARCADOR fino (medido: rect de ~2px de altura),
        // não o card. O frame é o .card-frame ancestral.
        const el = marker.closest('.card-frame') ?? marker;
        const inner = el.querySelector('.card-head-inner') ?? el;
        const btns = [...inner.querySelectorAll('button')];
        const b = btns[btns.length - 1];
        if (!b) return null;
        // DOM click, não clique por coordenada: o card NOVO nasce no TOPO do
        // empilhamento (y≈-1) e o header dele fica FORA da viewport — um clique
        // por coordenada erra o alvo (medido: "fechou" mas xterms não caía).
        b.click();
        return { label: b.textContent.trim().slice(0, 12), n: btns.length };
      })()
    `);
    if (!coords) return { clicked: false, label: "sem-botao" };
    return { clicked: true, label: coords.label, n: coords.n };
  }

  for (let i = 0; i < CARDS; i += 1) await spawnTerminal();
  console.log(`[ram] ${CARDS} cards criados; assentando 6s...`);
  await delay(6000);

  await page.send("Performance.enable");
  await page.send("HeapProfiler.enable");
  const metrics = async () => {
    await page.send("HeapProfiler.collectGarbage"); // heap RETIDO, não churn
    const m = (await page.send("Performance.getMetrics")).metrics;
    const v = (k) => Number((m.find((x) => x.name === k) ?? { value: 0 }).value);
    const dom = await page.evalJs(
      `JSON.stringify({ nodes: document.querySelectorAll("*").length, xterms: document.querySelectorAll(".xterm").length, reports: document.querySelectorAll("[data-role='report']").length })`,
    );
    let rendererMb = 0;
    let gpuMb = 0;
    let mainMb = 0;
    for (const pid of treePids(app.proc.pid)) {
      const p = readProc(pid);
      if (!p) continue;
      if (p.type === "renderer") rendererMb += p.rssKb / 1024;
      else if (p.type === "gpu-process") gpuMb += p.rssKb / 1024;
      else if (p.type === "electron-main") mainMb += p.rssKb / 1024;
    }
    return {
      jsHeapMb: v("JSHeapUsedSize") / 1024 / 1024,
      nodes: v("Nodes"),
      listeners: v("JSEventListeners"),
      dom: JSON.parse(dom),
      rendererMb: Math.round(rendererMb),
      gpuMb: Math.round(gpuMb),
      mainMb: Math.round(mainMb),
    };
  };

  console.log("\n=== (1) CURVA NO TEMPO (N fixo) ===");
  console.log("t(s)  heapMB  rendererMB  gpuMB  mainMB  nodes  listeners  domNodes  xterms");
  const curve = [];
  const t0 = Date.now();
  const totalMs = MINUTES * 60_000;
  for (let t = 0; t <= totalMs; t += INTERVAL * 1000) {
    if (t > 0) await delay(INTERVAL * 1000);
    const s = await metrics();
    const row = { t: Math.round((Date.now() - t0) / 1000), ...s };
    curve.push(row);
    console.log(
      `${String(row.t).padStart(4)}  ${row.jsHeapMb.toFixed(1).padStart(6)}  ${String(row.rendererMb).padStart(10)}  ${String(row.gpuMb).padStart(5)}  ${String(row.mainMb).padStart(6)}  ${String(row.nodes).padStart(5)}  ${String(row.listeners).padStart(9)}  ${String(row.dom.domNodes ?? row.dom.nodes).padStart(8)}  ${String(row.dom.xterms).padStart(6)}`,
    );
  }
  const first = curve[0];
  const last = curve[curve.length - 1];
  const dMin = (last.t - first.t) / 60;
  const slope = dMin > 0 ? (last.jsHeapMb - first.jsHeapMb) / dMin : 0;
  const slopeRss = dMin > 0 ? (last.rendererMb - first.rendererMb) / dMin : 0;
  console.log(`\n[ram] HEAP retido: ${first.jsHeapMb.toFixed(1)} -> ${last.jsHeapMb.toFixed(1)} MB em ${dMin.toFixed(1)} min = ${slope.toFixed(2)} MB/min`);
  console.log(`[ram] renderer RSS: ${first.rendererMb} -> ${last.rendererMb} MB = ${slopeRss.toFixed(2)} MB/min`);

  console.log("\n=== (2) CICLO ABRIR/FECHAR ===");
  const baseBefore = await metrics();
  console.log(`[ram] baseline antes do ciclo: heap=${baseBefore.jsHeapMb.toFixed(1)}MB renderer=${baseBefore.rendererMb}MB xterms=${baseBefore.dom.xterms} dom=${baseBefore.dom.nodes}`);
  const cycleRows = [];
  for (let k = 0; k < CYCLE; k += 1) {
    await spawnTerminal();
    await delay(1500);
    const afterOpen = await metrics();
    const ids = Object.keys(await terminalIds());
    const victim = ids[ids.length - 1];
    const res = await closeCard(victim);
    await delay(2500);
    const afterClose = await metrics();
    // "fechou" = o número de xterms CAIU (a evidência é a tela, não o clique).
    const closed = afterClose.dom.xterms < afterOpen.dom.xterms;
    cycleRows.push({ k, afterOpen, afterClose, clicked: closed, button: res.label ?? null });
    console.log(
      `[ram] ciclo ${k + 1}: ${closed ? "fechou" : "NAO fechou"} (botao="${res.label ?? "?"}") — abrir: heap=${afterOpen.jsHeapMb.toFixed(1)} renderer=${afterOpen.rendererMb} xterms=${afterOpen.dom.xterms} | fechar: heap=${afterClose.jsHeapMb.toFixed(1)} renderer=${afterClose.rendererMb} xterms=${afterClose.dom.xterms}`,
    );
  }
  const baseAfter = await metrics();
  console.log(`[ram] baseline DEPOIS do ciclo: heap=${baseAfter.jsHeapMb.toFixed(1)}MB renderer=${baseAfter.rendererMb}MB xterms=${baseAfter.dom.xterms} dom=${baseAfter.dom.nodes}`);
  console.log(`[ram] DELTA do ciclo (depois - antes): heap=${(baseAfter.jsHeapMb - baseBefore.jsHeapMb).toFixed(1)}MB renderer=${baseAfter.rendererMb - baseBefore.rendererMb}MB dom=${baseAfter.dom.nodes - baseBefore.dom.nodes} listeners=${baseAfter.listeners - baseBefore.listeners}`);

  console.log("\n=== RESUMO ===");
  console.log(JSON.stringify({ cards: CARDS, curveMin: dMin, heapSlopeMbPerMin: slope, rssSlopeMbPerMin: slopeRss, first, last, cycle: { before: baseBefore, after: baseAfter, rows: cycleRows.map((r) => ({ k: r.k, clicked: r.clicked, openHeap: r.afterOpen.jsHeapMb, closeHeap: r.afterClose.jsHeapMb, openRss: r.afterOpen.rendererMb, closeRss: r.afterClose.rendererMb })) } }, null, 2));

  page.close();
} finally {
  await stopApp(app);
}
