#!/usr/bin/env node
/**
 * DRIVER do spike wry/tao (task 3ec0ed3b). Sobe a fixture HTTP, roda o binário
 * `wry-spike` com N views e mede, de FORA (árvore de /proc), o que a WebView
 * nativa custa — o binário sozinho não vê os processos-filho do WebKit.
 *
 * Uso: node scripts/measure/wry-spike/run.mjs --views N [--hold-ms M]
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "target", "release", "wry-spike");
/** Tamanho de página do host (x86_64 Linux = 4096) — só o FALLBACK usa. */
const PAGE_SIZE_BYTES = 4096;

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1] ?? def;
};
const VIEWS = Number(arg("--views", "1"));
const HOLD_MS = Number(arg("--hold-ms", "9000"));
/** Sem os dois contornos do WebKit — para separar a atribuição do GBM (R8). */
const DEFAULT_WEBKIT = process.argv.includes("--default-webkit");

const HTML = `<!doctype html><html><head><title>spike</title><meta charset="utf-8"></head><body>
SPIKE-MARKER text for eval coverage — acentuação ção.
<div id="box" style="width:200px;height:80px;background:#f80"></div>
<input id="inp" value="">
<button id="btn" onclick="document.title='SPIKE-CLICKED'">Salvar</button>
</body></html>`;

const server = createServer((_req, res) => {
  const body = Buffer.from(HTML, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

/**
 * RSS em kB do processo. CORREÇÃO (review R8, 2026-10-01): `/proc/<pid>/stat`
 * campo 24 (`rss`) está em PÁGINAS, não em kB — a primeira versão devolvia
 * páginas cruas e o doc publicou ~4× MENOS (ex.: pid1 stat[24]=5634 vs VmRSS
 * real 22548 kB; 5634×4=22536). Agora lê `VmRSS` de `/proc/<pid>/status`, que
 * já vem em kB; o caminho antigo fica como FALLBACK multiplicado pelo tamanho
 * de página.
 */
function readProcRssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    if (m) return Number(m[1]);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const pages = Number(stat.slice(close + 2).split(" ")[21]);
    return pages * (PAGE_SIZE_BYTES / 1024);
  } catch {
    return 0;
  }
}
function byParent() {
  const map = new Map();
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (!map.has(ppid)) map.set(ppid, []);
      map.get(ppid).push(Number(e));
    } catch {}
  }
  return map;
}
function tree(rootPid) {
  const bp = byParent();
  const out = [];
  const walk = (p) => {
    for (const c of bp.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(rootPid);
  return out;
}
function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 70);
  } catch {
    return "";
  }
}

console.log(`[wry-spike] views=${VIEWS} hold=${HOLD_MS}ms url=${url}`);
const proc = spawn(BIN, ["--views", String(VIEWS), "--url", url, "--hold-ms", String(HOLD_MS)], {
  stdio: ["ignore", "pipe", "pipe"],
  // MEDIDO: em Wayland puro o wry 0.57 recusa o handle da janela do tao
  // (`UnsupportedWindowHandle`). Com o backend X11 (XWayland) o build aceita.
  env: {
    ...process.env,
    // Wayland puro: wry 0.57 recusa a janela (`UnsupportedWindowHandle`).
    GDK_BACKEND: "x11",
    // CONFIG MEDIDA (default): os dois contornos do WebKit. `--default-webkit`
    // os REMOVE para separar a atribuição (review R8): com eles o stderr fica
    // LIMPO e a página AINDA não carrega; o `Failed to create GBM buffer` só
    // aparece no caminho SEM eles.
    ...(DEFAULT_WEBKIT
      ? {}
      : { WEBKIT_DISABLE_DMABUF_RENDERER: "1", WEBKIT_DISABLE_COMPOSITING_MODE: "1" }),
  },
});

const stages = [];
let buf = "";
let stderrText = "";
proc.stderr.on("data", (d) => (stderrText += d.toString()));
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    console.log(`[bin] ${line}`);
    try {
      stages.push(JSON.parse(line));
    } catch {}
  }
});

// Amostra a árvore de /proc a cada 500ms; guarda os picos e as contagens.
const samples = [];
const poll = setInterval(() => {
  const pids = tree(proc.pid).filter((p) => existsSync(`/proc/${p}`));
  let totalKb = readProcRssKb(proc.pid);
  const kinds = { ui: 1, web: 0, net: 0, gpu: 0, other: 0 };
  for (const p of pids) {
    totalKb += readProcRssKb(p);
    const c = cmdline(p);
    if (c.includes("WebProcess")) kinds.web++;
    else if (c.includes("NetworkProcess")) kinds.net++;
    else if (c.includes("GPUProcess")) kinds.gpu++;
    else kinds.other++;
  }
  samples.push({ t: Date.now(), totalKb, kinds, procs: pids.length + 1 });
}, 500);

await new Promise((resolve) => proc.on("exit", resolve));
clearInterval(poll);
server.close();

// Estável = mediana das amostras DEPOIS dos primeiros 3s (load assentou).
const steady = samples.filter((s) => s.t > (samples[0]?.t ?? 0) + 3000);
const pick = steady.length ? steady : samples;
const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0;
const steadyKb = med(pick.map((s) => s.totalKb));
const last = pick[pick.length - 1] ?? samples[samples.length - 1] ?? { kinds: {}, procs: 0 };

const created = stages.find((s) => s.stage === "created");
const boot = stages.find((s) => s.stage === "boot");
const ev = stages.find((s) => s.stage === "eval");

console.log("\n=== RESULTADO ===");
console.log(
  JSON.stringify(
    {
      views: VIEWS,
      webkitConfig: DEFAULT_WEBKIT ? "default (so GDK_BACKEND=x11)" : "medida (DMA-BUF + compositor desligados)",
      gbmErrorLines: (stderrText.match(/GBM buffer/g) || []).length,
      createMs: created?.ms ?? null,
      load: stages.find((s) => s.stage === "load") ?? null,
      uiVmRssKbBoot: boot?.vmRssKb ?? null,
      uiVmRssKbCreated: created?.vmRssKb ?? null,
      uiVmRssKbAfterEval: stages.find((s) => s.stage === "after-eval")?.vmRssKb ?? null,
      treeRssKbSteady: steadyKb,
      treeRssMbSteady: Math.round(steadyKb / 1024),
      processesTotal: last.procs,
      webProcesses: last.kinds.web ?? 0,
      networkProcesses: last.kinds.net ?? 0,
      gpuProcesses: last.kinds.gpu ?? 0,
      eval: ev
        ? {
            hasMarker: ev.hasMarker,
            innerTextBytes: ev.innerTextBytes,
            rect: ev.rect,
            typed: ev.typed,
            title: ev.title,
            usText: ev.usText,
            usRect: ev.usRect,
            usType: ev.usType,
            usClick: ev.usClick,
          }
        : null,
    },
    null,
    2,
  ),
);
