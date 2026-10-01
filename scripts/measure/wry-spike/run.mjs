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

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1] ?? def;
};
const VIEWS = Number(arg("--views", "1"));
const HOLD_MS = Number(arg("--hold-ms", "9000"));

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

function readProcRssKb(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return Number(stat.slice(close + 2).split(" ")[21]);
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
  stdio: ["ignore", "pipe", "inherit"],
  // MEDIDO: em Wayland puro o wry 0.57 recusa o handle da janela do tao
  // (`UnsupportedWindowHandle`). Com o backend X11 (XWayland) o build aceita.
  env: {
    ...process.env,
    GDK_BACKEND: "x11",
    // MEDIDO: sem isto o WebKitGTK falha o renderer DMA-BUF
    // ("Failed to create GBM buffer of size …: Argumento inválido") e a página
    // NUNCA carrega. São os dois contornos documentados do WebKit em ambiente
    // sem GPU/DMA-BUF utilizável.
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
  },
});

const stages = [];
let buf = "";
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
