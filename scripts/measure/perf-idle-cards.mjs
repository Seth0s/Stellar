#!/usr/bin/env node
/**
 * CUSTO POR CARD OCIOSO QUE REPINTA (task 27e13021, "MEASURE FIRST").
 *
 * O sintoma do dono: ~10 fps, CPU alto, GPU ~0%, RAM+swap esgotados com cards de
 * agente OCIOSOS abertos. Este harness mede a parte que é ATRIBUÍVEL ao Stellar —
 * o custo por card ocioso que continua emitindo bytes — sem agente real, sem
 * login e sem quota:
 *
 *   · instância ISOLADA (userData em tmp, destruída e verificada no fim);
 *   · N cards de bash rodando `fixtures/idle-tui.mjs`, que repinta na taxa pedida
 *     e REPORTA os bytes/s que ofereceu (o denominador do custo);
 *   · amostragem de CPU%/RSS por PROCESSO do Stellar (main/renderer/gpu/zygote),
 *     lida de /proc — nunca do processo do dono.
 *
 * Como ler o resultado (a razão do "--cards 0"): o número que interessa não é o
 * total, é o MARGINAL. Rode com --cards 0 (linha de base) e com --cards N, e passe
 * o JSON da primeira em --baseline: o harness imprime o custo POR CARD.
 *
 * Uso:
 *   node scripts/measure/perf-idle-cards.mjs --cards 0  --seconds 30 --json /tmp/base.json
 *   node scripts/measure/perf-idle-cards.mjs --cards 5  --seconds 30 --baseline /tmp/base.json
 *   node scripts/measure/perf-idle-cards.mjs --cards 5  --browser        # + 1 card de navegador
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, pickFreePort } from "../verify/cdp-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "idle-tui.mjs");
const CLK_TCK = 100; // Linux: _SC_CLK_TCK. O harness é Linux-only por ora.

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const CARDS = Number(arg("--cards", "5"));
const SECONDS = Number(arg("--seconds", "30"));
const RATE = Number(arg("--rate", "10"));
const JSON_OUT = arg("--json", null);
const BASELINE = arg("--baseline", null);
const WITH_BROWSER = process.argv.includes("--browser");
// Provider REAL (ex.: cline): os cards abrem e ficam OCIOSOS - sem prompt, sem
// quota - para medir a taxa de PTY que um TUI de verdade produz (task 27e13021,
// passo 1: calibrar). Sem --provider, o modo e a TUI sintetica em bash.
const PROVIDER = arg("--provider", "bash");
const REAL_IDLE = PROVIDER !== "bash";
// `--exec <cmd>`: comando que cada card BASH roda em primeiro plano (ex.:
// `exec /home/lucas/.local/bin/cline`). E o caminho para medir a taxa de PTY de
// uma CLI REAL sem depender do gate de spawn de provider - e sem prompt.
const EXEC = arg("--exec", null);
// `--profile`: perfil de CPU do RENDERER por N segundos (padrão 10) mais o delta
// de métricas do Blink. É o que responde "o que roda a cada frame" com nome e
// linha, em vez de palpites sobre animações.
const PROFILE = process.argv.includes("--profile");
const PROFILE_SECONDS = Number(arg("--profile-seconds", "10"));
// `--app-args "--flag1 --flag2"`: passthrough para o Electron. H2 usa isto para
// abrir o alvo `--inspect` do MAIN e ler `app.getGPUFeatureStatus()`.
const APP_ARGS = (arg("--app-args", "") || "").split(" ").filter(Boolean);
// `--profile-main`: perfil de CPU do processo MAIN (alvo `--inspect`) - quem faz
// as varreduras que continuam rodando sem um byte de PTY.
const PROFILE_MAIN = process.argv.includes("--profile-main");
// Pagina do card de navegador: data URL com animacao CSS, para o pipeline de
// frames ter o que pintar SEM rede (H3).
// O APP RECUSA `data:` (medido: "the embedded browser only opens http(s) URLs"),
// então o harness serve a página de teste em 127.0.0.1 — sem rede externa, e com
// uma animação CSS para o pipeline de frames ter o que pintar.
const BROWSER_PAGE_STATIC = `<!doctype html><body style="margin:0;background:#111">
<div style="width:120px;height:120px;background:#f80"></div></body>`;
const BROWSER_PAGE_ANIMATED = `<!doctype html><body style="margin:0;background:#111">
<div style="width:120px;height:120px;background:#f80;animation:s 1s linear infinite"></div>
<style>@keyframes s{to{transform:rotate(360deg)}}</style></body>`;
// `--browser-page static` serve a pagina SEM animacao: o contraste que mostra se o
// caminho de frames roda quando nada muda na pagina.
const BROWSER_PAGE = arg("--browser-page", "animated") === "static" ? BROWSER_PAGE_STATIC : BROWSER_PAGE_ANIMATED;
async function startBrowserServer() {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(BROWSER_PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}
const BROWSER_URL = arg(
  "--browser-url",
  "data:text/html,<body style='margin:0;background:%23111'><div style='width:120px;height:120px;background:%23f80;animation:s 1s linear infinite'></div><style>@keyframes s{to{transform:rotate(360deg)}}</style></body>",
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lê utime+stime (ticks), RSS (kB) e o `--type=` do cmdline de um pid. */
/**
 * CPU ocupada da MÁQUINA INTEIRA (todas as linhas `cpu` de /proc/stat), em
 * "ticks ocupados". Existe porque a primeira rodada deste harness mediu o
 * baseline a 0,3% e, minutos depois, 20,7% com o MESMO build — outro card
 * trabalhando na mesma máquina. Sem este número, uma variação de carga vira
 * "o conserto piorou".
 */
function machineBusyTicks() {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  const total = nums.reduce((a, b) => a + b, 0);
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
  return { total, busy: total - idle };
}

/**
 * `/proc/<pid>/io`: quanto o PROCESSO escreveu no mundo (wchar). É a métrica que
 * o orquestrador usou na máquina dele, e ela conta arquivo, rede e log — não só
 * PTY. Medir as duas na MESMA janela é o que separa "a CLI escreve muito" de "a
 * CLI escreve muito PARA O PTY" (task 27e13021, passo 1).
 */
function readProcIo(pid) {
  const out = { wchar: 0, syscw: 0 };
  try {
    const text = readFileSync(`/proc/${pid}/io`, "utf8");
    for (const line of text.split("\n")) {
      const [key, value] = line.split(": ");
      if (key === "wchar") out.wchar = Number(value);
      if (key === "syscw") out.syscw = Number(value);
    }
  } catch {
    // processo morreu: zero é a resposta honesta para este instante
  }
  return out;
}

function readProc(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    const rssKb = Number(fields[21]);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    // ATRIBUICAO (corrigida 2026-09-23): um processo filho SEM `--type=` nao e o
    // main do Electron - e a CLI do agente (cline/bash), que roda como filho do app
    // e nao tem marcador nenhum. Antes tudo isso caia no balde "main" e o custo da
    // CLI aparecia como custo do Stellar (medido: o perfil do main real via --inspect
    // fica 100% ocioso com 4 clines parados).
    let type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? null;
    if (type === null) {
      type = cmdline.includes("out/main/index.js") ? "electron-main" : "cli";
    }
    return { pid, cpuTicks: utime + stime, rssKb, type };
  } catch {
    return null;
  }
}

/** Todos os descendentes do pid raiz (o app é `detached`, então o grupo é dele). */
function treePids(rootPid) {
  const byParent = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(Number(entry));
    } catch {
      // processo morreu entre o readdir e o read: ignora.
    }
  }
  const out = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(rootPid);
  return out;
}

  /** Pids das CLIs reais (filhos do app cujo cmdline cita o binário do provider). */
  function cliPids(rootPid, provider) {
    const alvos = provider === "cline" ? ["cline"] : [provider];
    const out = [];
    for (const pid of treePids(rootPid)) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (alvos.some((alvo) => cmdline.includes(alvo))) out.push(pid);
      } catch {
        // ignora
      }
    }
    return out;
  }

/**
 * Perfil de CPU do renderer + métricas do Blink, pelo CDP. Devolve as funções
 * por SELF TIME (o que de fato queima CPU, não quem chamou) e o delta das
 * contagens do Blink na mesma janela.
 */
async function profileRenderer(cdpPort, seconds) {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const alvo = list.find((t) => t.type === "page");
  if (!alvo) throw new Error("nenhum alvo page para perfilar");
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pend = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const resolver = pend.get(msg.id);
    if (resolver) {
      pend.delete(msg.id);
      resolver(msg.result);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pend.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send("Profiler.enable");
  await send("Performance.enable");
  await send("Profiler.setSamplingInterval", { interval: 200 });
  const antes = (await send("Performance.getMetrics")).metrics;
  await send("Profiler.start");
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const perfil = await send("Profiler.stop");
  const depois = (await send("Performance.getMetrics")).metrics;
  ws.close();

  const porNome = new Map();
  const nodes = new Map(perfil.profile.nodes.map((n) => [n.id, n]));
  const total = perfil.profile.samples.length || 1;
  const dt = (perfil.profile.endTime - perfil.profile.startTime) / 1000;
  for (const amostra of perfil.profile.samples) {
    const node = nodes.get(amostra);
    if (!node) continue;
    const cf = node.callFrame;
    const chave = `${cf.functionName || "(anon)"} @ ${cf.url.split("/").pop() || "?"}:${cf.lineNumber + 1}`;
    porNome.set(chave, (porNome.get(chave) ?? 0) + 1);
  }
  const top = [...porNome.entries()]
    .map(([nome, hits]) => ({ nome, selfMs: (hits / total) * dt, pct: (hits / total) * 100 }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 12);

  const metric = (lista, chave) => Number((lista.find((m) => m.name === chave) ?? { value: 0 }).value);
  const delta = {};
  for (const chave of ["LayoutCount", "RecalcStyleCount", "TaskDuration", "ScriptDuration", "JSHeapUsedSize"]) {
    delta[chave] = metric(depois, chave) - metric(antes, chave);
  }
  return { top, delta, totalSamples: total, seconds: dt };
}


/**
 * H2: le `app.getGPUFeatureStatus()` NO PROCESSO MAIN.
 *
 * O main do Electron não é alvo de CDP a menos que se passe `--inspect`; com ele
 * há um alvo `node` em /json/list, e um `Runtime.evaluate` lá roda no main - sem
 * precisar de IPC novo (a medição usa a porta de inspeção, que é descartável).
 * O import dinâmico é de propósito: o main é empacotado como ESM, então `require`
 * pode não existir no escopo do evaluate.
 */
async function readGpuStatus(inspectPort, exprIndex = 0) {
  const alvo = (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()).find(
    (t) => t.type === "node" || String(t.url || "").includes("node"),
  );
  if (!alvo) return null;
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const resultado = await new Promise((resolve) => {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) resolve(msg.result);
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: [
            'globalThis.require ? JSON.stringify(require("electron").app.getGPUFeatureStatus()) : null',
            'JSON.stringify(process.mainModule.require("electron").app.getGPUFeatureStatus())',
            'import("electron").then((m) => JSON.stringify(m.app.getGPUFeatureStatus()))',
          ][exprIndex],
          awaitPromise: true,
          returnByValue: true,
        },
      }),
    );
  });
  ws.close();
  if (resultado?.exceptionDetails) {
    return { erro: String(resultado.exceptionDetails.text || resultado.exceptionDetails.exception?.description || "") };
  }
  const valor = resultado?.result?.value;
  if (typeof valor !== "string") return null;
  try {
    return JSON.parse(valor);
  } catch {
    return null;
  }
}


/**
 * Perfil de CPU do processo MAIN pelo alvo `--inspect`. É o que responde "o que o
 * main faz sem um byte de PTY": as varreduras periodicamente agendadas
 * (session-watch, watchdog de idle, card_traces). Devolve self time por função.
 */
async function profileMain(inspectPort, seconds) {
  const alvo = (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()).find(
    (t) => String(t.description || "").includes("node"),
  );
  if (!alvo) return null;
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pend = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const resolver = pend.get(msg.id);
    if (resolver) {
      pend.delete(msg.id);
      resolver(msg.result);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const msgId = ++id;
      pend.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 200 });
  await send("Profiler.start");
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const perfil = await send("Profiler.stop");
  ws.close();
  const nodes = new Map(perfil.profile.nodes.map((n) => [n.id, n]));
  const total = perfil.profile.samples.length || 1;
  const dt = (perfil.profile.endTime - perfil.profile.startTime) / 1000;
  const porNome = new Map();
  for (const amostra of perfil.profile.samples) {
    const node = nodes.get(amostra);
    if (!node) continue;
    const cf = node.callFrame;
    const chave = `${cf.functionName || "(anon)"} @ ${String(cf.url).split("/").pop() || "?"}:${cf.lineNumber + 1}`;
    porNome.set(chave, (porNome.get(chave) ?? 0) + 1);
  }
  return {
    seconds: dt,
    top: [...porNome.entries()]
      .map(([nome, hits]) => ({ nome, selfMs: (hits / total) * dt }))
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 12),
  };
}

async function main() {
  if (!existsSync(FIXTURE)) throw new Error(`fixture ausente: ${FIXTURE}`);
  const userDataDir = join(tmpdir(), `stellar-perf-${process.pid}`);
  const cdpPort = await pickFreePort();
  console.log(`[perf] instância ISOLADA: userData=${userDataDir} cdp=${cdpPort} cards=${CARDS} provider=${PROVIDER}${REAL_IDLE ? " (ocioso, sem prompt)" : ` rate=${RATE}fps`}`);

  // Declarado FORA do try: o finally precisa fechar o servidor da página.
  let browserServer = null;
  const app = await startApp({ cdpPort, userDataDir, timeoutMs: 60_000, extraArgs: APP_ARGS });
  let page = null;
  try {
    page = await connectPage(cdpPort);
    // Uma instância nova não tem board nenhum (o app cria quando o humano abre
    // uma sessão). Aqui o board é criado pela MESMA API da UI, sem clique: o
    // benchmark não pode depender de coordenadas de tela para medir CPU.
    const boardId = await page.evalJs(`(async () => {
      const existentes = await window.store.boards.list();
      if (existentes.length > 0) return existentes[0].id;
      const now = Date.now();
      const id = "perf-board";
      await window.store.boards.upsert({ id, name: "Perf", project: "Perf", cwd: "/tmp", created_at: now, updated_at: now,
        last_accessed_at: now, autonomous: 0, concurrency_cap: null, orchestrator_card_id: null });
      const depois = await window.store.boards.list();
      return depois.length > 0 ? depois[0].id : null;
    })()`);
    if (!boardId) throw new Error("board não pôde ser criado na instância isolada");

    let browserUrl = BROWSER_URL;

    // Cards: o MESMO caminho da UI (persistir a linha + subir o PTY), pela API do
    // renderer — sem consentimento de agente e sem passar pelo bus de mensagens.
    for (let i = 0; i < CARDS; i += 1) {
      const id = `perf-card-${i}`;
      await page.evalJs(`(async () => {
        const now = Date.now();
        await window.store.upsert({ id: ${JSON.stringify(id)}, provider: "bash", cwd: "/tmp", x: 40 + ${i} * 30, y: 40, w: 700, h: 360,
          updated_at: now, resume_id: null, model: null, system_prompt: null, kind: "terminal", board_id: ${JSON.stringify(boardId)},
          group_id: null, label: ${JSON.stringify(id)}, messages_json: null, archived_at: null, effort: null, created_at: now });
        await window.pty.spawn(${JSON.stringify(id)}, ${JSON.stringify(PROVIDER)}, "/tmp", 80, 24);
        return true;
      })()`);
    }


    if (WITH_BROWSER) {
      const servidor = await startBrowserServer();
      browserServer = servidor.server;
      browserUrl = servidor.url;
      await page.evalJs(`(async () => {
        const now = Date.now();
        await window.store.upsert({ id: "perf-browser", provider: "browser", cwd: "/tmp", x: 40, y: 420, w: 700, h: 360,
          updated_at: now, resume_id: null, model: null, system_prompt: null, kind: "browser", board_id: ${JSON.stringify(boardId)},
          group_id: null, label: "perf-browser", messages_json: null, archived_at: null, effort: null, created_at: now });
        // O IPC que a UI usa (H3): sem isto o card era so uma LINHA no banco e o
        // WebContentsView - o que de fato custa frames - nunca nascia. O app RECUSA
        // o esquema data: ("only opens http(s) URLs"), por isso o harness serve a pagina.
        await window.browser.create("perf-browser", ${JSON.stringify(browserUrl)});
        return true;
      })()`);
    }

    // ANTES de medir: os cards EXISTEM de verdade? Um card que nao subiu mede
    // 0,00 KB/s e PARECE um resultado - foi o que aconteceu uma vez aqui.
    const vivos = await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((cs) => cs.map((c) => c.id))`);
    // Baseline de 0 cards é uma configuração LEGÍTIMA: sem cards, não há o que
    // verificar (a asserção existe para pegar card que NÃO subiu quando devia).
    if (CARDS > 0 && (!Array.isArray(vivos) || vivos.length < CARDS)) {
      throw new Error(`cards nao subiram: esperados ${CARDS}, no store ${JSON.stringify(vivos)}`);
    }
    const shells = treePids(app.proc.pid).filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("bash");
      } catch {
        return false;
      }
    });
    if (CARDS > 0 && shells.length === 0) throw new Error("nenhum processo bash filho: os cards nao tem PTY vivo");
    console.log(`[perf] VERIFICADO: ${vivos.length} card(s) no store, ${shells.length} shell(s) vivo(s)`);
    await delay(4000); // os shells sobem
    if (!REAL_IDLE || EXEC !== null) {
      for (let i = 0; i < CARDS; i += 1) {
        const cmd = EXEC ?? `node ${FIXTURE} ${RATE}`;
        await page.evalJs(`window.pty.write("perf-card-${i}", ${JSON.stringify(cmd + "\r")}, "human").then(() => true)`);
      }
    }
    await delay(4000); // a TUI sintética começa a repintar

    if (process.env.PERF_DEBUG) {
      console.log(`[perf:debug] main=${app.proc.pid} vivos=${app.proc.exitCode === null} arvore=${treePids(app.proc.pid).length}`);
    }
    const pids = treePids(app.proc.pid);
    const before = new Map();
    for (const pid of pids) {
      const proc = readProc(pid);
      if (proc) before.set(pid, proc);
    }
    const t0 = Date.now();
    let perfil = null;
    if (PROFILE) {
      perfil = await profileRenderer(cdpPort, PROFILE_SECONDS);
      console.log(`\n[perf] PERFIL do renderer (${perfil.seconds.toFixed(1)}s, ${perfil.totalSamples} amostras) - top por self time:`);
      for (const linha of perfil.top) {
        console.log(`  ${linha.selfMs.toFixed(1).padStart(7)} ms  ${linha.pct.toFixed(1).padStart(5)}%  ${linha.nome}`);
      }
      console.log(`[perf] Blink no mesmo intervalo: ${JSON.stringify(perfil.delta)}`);
    }

    if (PROFILE_MAIN) {
      const alvoInspect = APP_ARGS.find((a) => a.startsWith("--inspect="));
      if (!alvoInspect) throw new Error("--profile-main exige --app-args \"--inspect=<porta>\"");
      const perfilMain = await profileMain(alvoInspect.split("=")[1], PROFILE_SECONDS);
      console.log(`\n[perf] PERFIL do MAIN (${perfilMain?.seconds?.toFixed(1)}s) - top por self time:`);
      for (const linha of perfilMain?.top ?? []) console.log(`  ${linha.selfMs.toFixed(1).padStart(7)} ms  ${linha.nome}`);
    }

    const inspectArg = APP_ARGS.find((a) => a.startsWith("--inspect="));
    let gpuStatus = null;
    if (inspectArg) {
      // Tenta as formas em ordem e para na primeira que responder: o contexto do
      // inspector do MAIN não garante `require` (o main é empacotado como ESM) e
      // também pode recusar `import()`; a mensagem de erro de cada tentativa é
      // preservada em vez de virar "não respondeu".
      for (let expr = 0; expr < 3 && (gpuStatus === null || gpuStatus.erro); expr += 1) {
        gpuStatus = await readGpuStatus(inspectArg.split("=")[1], expr);
      }
    }
    if (inspectArg) {
      console.log(`\n[perf] GPU status (main, app.getGPUFeatureStatus()):`);
      console.log(gpuStatus ? `  ${JSON.stringify(gpuStatus)}` : "  (alvo node nao respondeu)");
    }

    const cliAntes = new Map(cliPids(app.proc.pid, PROVIDER).map((pid) => [pid, readProcIo(pid)]));
    const cpuT0 = machineBusyTicks();
    await delay(SECONDS * 1000);
    const elapsed = (Date.now() - t0) / 1000;
    const cpuT1 = machineBusyTicks();
    const machineBusyPct =
      cpuT1.total > cpuT0.total ? ((cpuT1.busy - cpuT0.busy) / (cpuT1.total - cpuT0.total)) * 100 : 0;

    const rows = [];
    for (const pid of treePids(app.proc.pid)) {
      const now = readProc(pid);
      const prev = before.get(pid);
      if (!now) continue;
      rows.push({
        pid,
        type: now.type,
        cpuPct: prev ? ((now.cpuTicks - prev.cpuTicks) / (elapsed * CLK_TCK)) * 100 : 0,
        rssMb: now.rssKb / 1024,
      });
    }
    const byType = new Map();
    for (const row of rows) {
      const acc = byType.get(row.type) ?? { type: row.type, cpuPct: 0, rssMb: 0, count: 0 };
      acc.cpuPct += row.cpuPct;
      acc.rssMb += row.rssMb;
      acc.count += 1;
      byType.set(row.type, acc);
    }
    const totalCpu = [...byType.values()].reduce((s, r) => s + r.cpuPct, 0);
    const totalRss = [...byType.values()].reduce((s, r) => s + r.rssMb, 0);

    console.log(`\n[perf] ${CARDS} card(s) ociosos repintando a ${RATE} fps, ${elapsed.toFixed(1)}s de amostra`);
    console.log("processo        n   cpu%    rss(MB)");
    for (const row of [...byType.values()].sort((a, b) => b.cpuPct - a.cpuPct)) {
      console.log(`${row.type.padEnd(14)} ${String(row.count).padStart(2)}  ${row.cpuPct.toFixed(1).padStart(5)}  ${row.rssMb.toFixed(0).padStart(7)}`);
    }
    console.log(`${'TOTAL'.padEnd(14)} ${String(rows.length).padStart(2)}  ${totalCpu.toFixed(1).padStart(5)}  ${totalRss.toFixed(0).padStart(7)}`);
    // A carga da MÁQUINA, sempre ao lado do resultado: um número sem ela pode
    // atribuir a outro card o que é do Stellar (ou o contrário).
    console.log(`[perf] máquina ocupada no mesmo intervalo: ${machineBusyPct.toFixed(1)}% (inclui outros processos)`);
    // O log de mecanismo é lido ANTES de julgar wchar-vs-PTY: os dois números
    // saem da MESMA janela de amostragem.
    const ptyFrameLog = String(app.stderr())
      .split("\n")
      .filter((l) => l.includes("[pty-frame]"))
      .map((l) => l.trim());
    let cliWcharBytesPerSec = null;
    let ptyBytesPerSec = null;
    if (REAL_IDLE) {
      // wchar do PROCESSO DA CLI vs bytes que o STELLAR recebeu do PTY. Se o
      // primeiro for enorme e o segundo ~0, a métrica do orquestrador está
      // medindo outra coisa (log, banco), não o que atravessa o Stellar.
      let wcharDelta = 0;
      for (const [pid, antes] of cliAntes) {
        const depois = readProcIo(pid);
        wcharDelta += Math.max(0, depois.wchar - antes.wchar);
      }
      const ptyBytes = ptyFrameLog
        .map((l) => Number(/bytes=(\d+)/.exec(l)?.[1] ?? 0))
        .reduce((a, b) => a + b, 0);
      cliWcharBytesPerSec = wcharDelta / elapsed;
      ptyBytesPerSec = ptyBytes / elapsed;
      console.log(`[perf] CLI (wchar, todo I/O): ${(wcharDelta / elapsed / 1024).toFixed(1)} KB/s`);
      console.log(`[perf] PTY (bytes que o Stellar recebeu): ${(ptyBytes / elapsed / 1024).toFixed(2)} KB/s`);
    }

    const result = {
      cards: CARDS,
      rate: RATE,
      seconds: elapsed,
      machineBusyPct,
      withBrowser: WITH_BROWSER,
      totalCpuPct: totalCpu,
      totalRssMb: totalRss,
      byType: [...byType.values()],
      ...(perfil ? { profile: perfil } : {}),
      ...(gpuStatus ? { gpuStatus } : {}),
      ptyFrameLog,
      ...(REAL_IDLE ? { cliWcharBytesPerSec, ptyBytesPerSec } : {}),
    };
    if (BASELINE && existsSync(BASELINE)) {
      const base = JSON.parse(readFileSync(BASELINE, "utf8"));
      const dCards = CARDS - base.cards;
      const dCpu = totalCpu - base.totalCpuPct;
      const dRss = totalRss - base.totalRssMb;
      console.log(`\n[perf] MARGINAL vs baseline (${base.cards} card(s)): Δcpu=${dCpu.toFixed(1)}pp para ${dCards} card(s)`);
      if (dCards > 0) {
        console.log(`[perf] CUSTO POR CARD OCIOSO: cpu=${(dCpu / dCards).toFixed(2)}pp  rss=${(dRss / dCards).toFixed(0)} MB`);
        result.perCard = { cpuPct: dCpu / dCards, rssMb: dRss / dCards };
      }
    }
    if (process.env.STELLAR_PTY_FRAME_DEBUG === "1" || REAL_IDLE) {
      // O número de MECANISMO: quantas mensagens `pty:data` por 5 s o main
      // mandou. É imune a carga de máquina, ao contrário da CPU.
      const linhas = String(app.stderr())
        .split("\n")
        .filter((l) => l.includes("[pty-frame]"));
      result.ptyFrameLog = linhas.map((l) => l.trim());
      console.log(`\n[perf] mecanismo (main -> renderer):`);
      for (const linha of linhas) console.log(`  ${linha.trim()}`);
      result.ptyFrameLog = linhas.map((l) => l.trim());
    }
    if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    browserServer?.close();
    await stopApp(app);
    console.log(`[perf] userData isolado destruído: ${!existsSync(userDataDir)}`);
  }
}

main().catch((err) => {
  console.error(`[perf] falhou: ${err?.stack ?? err}`);
  process.exit(1);
});
