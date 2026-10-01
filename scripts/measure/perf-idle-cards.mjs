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
import {
  startApp,
  stopApp,
  connectPage,
  pickFreePort,
  bootIntoFreshSession,
  clickProviderInPicker,
} from "../verify/cdp-client.mjs";

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
// `--browser` cria 1; `--browsers N` cria N (custo MARGINAL por card de
// navegador — task 3dd34f94). O harness já criava o card a partir do store
// (`upsert` + `browser.create`), que é o único caminho que materializa o
// webContents offscreen.
const BROWSERS = Number(arg("--browsers", process.argv.includes("--browser") ? "1" : "0"));
const WITH_BROWSER = BROWSERS > 0;
// Provider REAL (ex.: cline): os cards abrem e ficam OCIOSOS - sem prompt, sem
// quota - para medir a taxa de PTY que um TUI de verdade produz (task 27e13021,
// passo 1: calibrar). Sem --provider, o modo e a TUI sintetica em bash.
const PROVIDER = arg("--provider", "bash");
const REAL_IDLE = PROVIDER !== "bash";
// `--exec <cmd>`: comando que cada card BASH roda em primeiro plano (ex.:
// `exec /home/lucas/.local/bin/cline`). E o caminho para medir a taxa de PTY de
// uma CLI REAL sem depender do gate de spawn de provider - e sem prompt.
const EXEC = arg("--exec", null);
// `--focus-cards N`: foca os N primeiros terminais (o blink agora e' so no focado).
// E' assim que se mede "blink so onde alguem olha" com o MESMO build: foco em 4
// (todos piscando) contra foco em 1 (so o que o humano ve).
const FOCUS_CARDS = Number(arg("--focus-cards", "0"));
// `--zoom <pct>`: afasta o zoom do board depois de criar os cards, pro GATE 2
// (todos intersectando a viewport) passar com N>1.
const ZOOM = arg("--zoom", null);
// `--pan-y <px>`: arrasta o FUNDO do board (área vazia) por N px — junto do
// zoom, traz pra viewport os cards que o empilhamento deixou acima do topo.
const PAN_Y = Number(arg("--pan-y", "0"));
// `--per-proc`: imprime o RSS de CADA processo com o cmdline — é o que separa
// a CLI do agente do shim `stellar-mcp` do Stellar (os dois são "cli").
const PER_PROC = process.argv.includes("--per-proc");
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
// `--no-webgl`: MEDE o custo do `WebglAddon` SEM mudar o código do app. Injeta
// um pre-script que faz TODO `getContext("webgl"/"webgl2")` devolver null — o
// xterm então cai no renderer DOM (o caminho que o próprio `useTerminal.ts` já
// tem no `catch` de `term.open()`). Rodar `--cards N` contra `--cards N
// --no-webgl` isola o custo do contexto WebGL por card, com o MESMO build.
// `__webglBlocked` conta os bloqueios — é a prova de que a sonda AGIU (sem ela,
// um run "sem WebGL" que não bloqueou nada seria lido como "WebGL de graça").
const NO_WEBGL = process.argv.includes("--no-webgl");
const NO_WEBGL_SCRIPT = `
(() => {
  window.__webglBlocked = 0;
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
      window.__webglBlocked = (window.__webglBlocked || 0) + 1;
      return null;
    }
    return orig.call(this, type, ...args);
  };
})();
`;
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

/**
 * Cria UM terminal do PROVIDER pedido: rail → "Adicionar card" → Terminal →
 * escolhe o provider no picker → botão primário do popover (é ELE que cria).
 *
 * MEDIDO 2026-10-01: o caminho do harness antigo (`openTerminalCreatePopover` +
 * `clickProviderInPicker`, SEM clicar o Criar) NÃO materializa card nenhum —
 * clicar o provider só SELECIONA; quem cria é `.popover-actions
 * button.primary`. E o helper compartilhado casa pelo RÓTULO do main, que para
 * o bash é "Bash" enquanto a UI mostra "bash" — daí o fallback por TEXTO.
 */
async function spawnTerminalOfProvider(page, providerId) {
  const clickSel = async (selector, what) => {
    const coords = await page.evalJs(`
      (() => {
        const b = document.querySelector(${JSON.stringify(selector)});
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `);
    if (!coords) throw new Error(`${what} nao encontrado`);
    await page.click(coords.x, coords.y);
    await delay(250);
  };
  await clickSel('[data-role="rail-add-card"]', "rail add-card");
  await clickSel('.popover-row[data-kind="terminal"]', "opcao Terminal no popover");
  let picked = false;
  try {
    await clickProviderInPicker(page, providerId);
    picked = true;
  } catch {
    // rótulo do main != texto da UI (bash) — casa pelo texto EXATO do botão.
  }
  if (!picked) {
    const coords = await page.evalJs(`
      (() => {
        const alvo = ${JSON.stringify(providerId)}.toLowerCase();
        const bs = [...document.querySelectorAll(".provider-picker-btn")].filter(
          (b) => b.textContent.trim().toLowerCase() === alvo,
        );
        if (bs.length !== 1) return null;
        const r = bs[0].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `);
    if (!coords) {
      const visible = await page.evalJs(
        `JSON.stringify([...document.querySelectorAll(".provider-picker-btn")].map((b) => b.textContent.trim()))`,
      );
      throw new Error(`provider "${providerId}" nao casou no picker (visiveis: ${visible})`);
    }
    await page.click(coords.x, coords.y);
    await delay(250);
  }
  await delay(150);
  await clickSel(".popover-actions button.primary", "botao Criar do popover de terminal");
  await delay(600);
}

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
    // `cmd` serve ao `--per-proc`: separar a CLI do AGENTE do shim
    // `stellar-mcp` do Stellar (os dois caem no balde "cli" — ambos são filhos
    // sem `--type=`). Sem isto, o custo do shim apareceria como custo da CLI.
    return { pid, cpuTicks: utime + stime, rssKb, type, cmd: cmdline.split("\0").filter(Boolean).join(" ").slice(0, 90) };
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

async function waitFor(fn, { timeoutMs = 8000, everyMs = 200 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await delay(everyMs);
  }
  return null;
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

    // Patch na PÁGINA VIVA, ANTES de qualquer terminal montar (o primeiro nasce
    // no `bootIntoFreshSession` logo abaixo): o xterm decide o renderer na hora
    // do `term.open()`, então o patch pega todos os cards deste run sem precisar
    // de documento novo.
    if (NO_WEBGL) {
      await page.evalJs(NO_WEBGL_SCRIPT);
      console.log("[perf] --no-webgl: getContext(webgl/webgl2) neutralizado na pagina viva");
    }

    let browserUrl = BROWSER_URL;

    // GATE 1 — O DOCUMENTO É O APP (task 27e13021). MEDIDO: sem isto, todas as
    // consultas de DOM rodaram contra a página de erro do Chromium
    // (`chrome-error://chromewebdata/`, com unreachableUrl apontando para
    // out/renderer/index.html) e TODO gate passou em falso: textareas 0, canvas 0,
    // enquanto o main respondia store/PTY normalmente. Renderer que não carregou não
    // tem o que medir — aborta nomeando o motivo, em vez de medir pixels de erro.
    // O gate é uma ESPERA, não uma foto: no instante do connectPage o renderer
    // ainda não montou os hooks do app (medido: protocol file: e sem chrome-error,
    // mas `hooks: false`). Espera até 15 s por um documento que seja o app.
    const docApp = await waitFor(
      async () => {
        const atual = JSON.parse(
          await page.evalJs(`JSON.stringify({
            href: location.href,
            protocol: location.protocol,
            erro: location.href.includes("chrome-error"),
            hooks: typeof window.__getTerminalDims === "function" && typeof window.store === "object",
          })`),
        );
        return !atual.erro && atual.protocol === "file:" && atual.hooks ? atual : null;
      },
      { timeoutMs: 15_000, everyMs: 250 },
    );
    if (!docApp) {
      const ultimo = await page.evalJs(
        `JSON.stringify({ href: location.href, protocol: location.protocol, hooks: typeof window.store })`,
      );
      throw new Error(
        `o documento NAO e o app depois de 15s (${ultimo}): o renderer nao carregou — toda medicao seria contra a pagina de erro`,
      );
    }

    // SEQUÊNCIA COPIADA DO SMOKE `smoke-terminal-scroll-to-end.mjs` (task 27e13021),
    // que é a prova viva de que este caminho renderiza um xterm:
    //   connectPage -> delay(1000) -> bootIntoFreshSession (default = com terminal)
    //   -> waitFor (até 8s, de 200ms) procurando o card de terminal E a prova de que
    //      o xterm está registrado no renderer (`window.__getTerminalDims(id)`).
    // As três diferenças que me custaram horas: eu NÃO esperava 1s depois do
    // connectPage, lia `boards.list()` UMA vez em vez de esperar, e não exigia a
    // prova de registro no xterm (só existência no store).
    await delay(1000);
    // SEM terminal default: TODOS os cards saem do MESMO caminho, com o
    // `--provider` pedido. O `bootIntoFreshSession` cria um terminal do
    // provider DEFAULT (bash) e não aceita provider por argumento — medir um
    // agente real exige criar cada card pelo picker dele.
    await bootIntoFreshSession(page, undefined, { spawnTerminal: false });

    const boardId = await page.evalJs(
      `window.store.boards.list().then((b) => (b.length > 0 ? b[0].id : null))`,
    );
    if (!boardId) throw new Error("a sessao nao expos um board ativo");

    // Cards pela UI (rail → Terminal → provider → Criar), esperando cada um
    // aparecer REGISTRADO no xterm — não apenas no store.
    let idsCriados = [];
    for (let i = 0; i < CARDS; i += 1) {
      await spawnTerminalOfProvider(page, PROVIDER);
      const novos = await waitFor(async () => {
        const ids = JSON.parse(
          await page.evalJs(`
            (async () => {
              const boards = await window.store.boards.list();
              const cards = await window.store.list(boards[0].id);
              return JSON.stringify(
                cards.filter((c) => c.kind === "terminal" && window.__getTerminalDims?.(c.id)).map((c) => c.id),
              );
            })()
          `),
        );
        return Array.isArray(ids) && ids.length > idsCriados.length ? ids : null;
      }, { timeoutMs: 25_000, everyMs: 250 });
      if (!novos) throw new Error(`card ${i} do provider "${PROVIDER}" nao registrou no xterm em 25s`);
      idsCriados = novos;
      console.log(`[perf] card ${i + 1}/${CARDS} (${PROVIDER}) registrado no xterm: ${idsCriados.join(", ")}`);
    }
    // `--zoom <pct>`: o board empilha cards novos PARA CIMA e os antigos saem da
    // viewport (medido: card 2 em y=-1849 com 3 cards) — o GATE 2 exige todos
    // INTERSECTANDO, então com N>1 é preciso afastar o zoom pra caberem. Sem
    // isto, os cards de fora nunca passam por `visible` e nem criam renderer.
    if (ZOOM !== null) {
      const zc = await page.evalJs(`(() => { const el = document.querySelector('.zoom-readout'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
      if (zc) {
        await page.click(zc.x, zc.y);
        await delay(200);
        const zi = await page.evalJs(`(() => { const el = document.querySelector('.zoom-input'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
        if (zi) {
          await page.click(zi.x, zi.y);
          await page.evalJs(`(() => { const inp = document.querySelector('.zoom-input'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(inp, ${JSON.stringify(String(ZOOM))}); inp.dispatchEvent(new Event('input', { bubbles: true })); })()`);
          await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          await delay(500);
          console.log(`[perf] zoom do board ajustado para ${ZOOM}%`);
        }
      }
    }
    if (PAN_Y !== 0) {
      // Arrasta o FUNDO (x=1150 fica à direita dos cards) — o board move junto.
      const x = 1150;
      const y0 = 300;
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: y0, button: "left", clickCount: 1, pointerType: "mouse" });
      for (let s = 1; s <= 8; s += 1) {
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y0 + Math.round((PAN_Y * s) / 8), button: "left", pointerType: "mouse" });
        await delay(20);
      }
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: y0 + PAN_Y, button: "left", clickCount: 1, pointerType: "mouse" });
      await delay(400);
      console.log(`[perf] board pan +${PAN_Y}px`);
    }


    // A SESSÃO PRECISA ESTAR ABERTA ANTES DOS CARDS (task 27e13021): sem isto o
    // board não monta, os cards existem no store mas NÃO estão na tela, e todo
    // número "por card" mede outra coisa. Medido: com 4 cards verificados, o
    // renderer reportava textareas=0 e canvas=0.
    // `spawnTerminal: true` quando já se quer UM card: é o caminho que TODO smoke
    // exercita (abre a sessão e cria um terminal de verdade pela UI). Os cards
    // extras entram pelo popover + picker abaixo.

    // CARDS PELA UI (task 27e13021). A criacao por API (store.upsert + pty.spawn)
    // NAO materializa terminal na tela - medido: 4 cards verificados no store com
    // textareas=0 no DOM, e o harness abortava por isso. Este e' o caminho que os
    // smokes ja provam: o botao da rail / o popover de tipo, com clique de verdade.
    // A sessão já pode ter criado o(s) primeiro(s) pelo caminho dos smokes; o
    // laço só completa o que falta, e o que vale é a contagem final no store.

    if (WITH_BROWSER) {
      const servidor = await startBrowserServer();
      browserServer = servidor.server;
      browserUrl = servidor.url;
      await page.evalJs(`(async () => {
        for (let i = 0; i < ${BROWSERS}; i += 1) {
          const id = "perf-browser-" + i;
          const now = Date.now();
          await window.store.upsert({ id, provider: "browser", cwd: "/tmp", x: 40 + i * 60, y: 420 + i * 40, w: 700, h: 360,
            updated_at: now, resume_id: null, model: null, system_prompt: null, kind: "browser", board_id: ${JSON.stringify(boardId)},
            group_id: null, label: id, messages_json: null, archived_at: null, effort: null, created_at: now });
          // O IPC que a UI usa (H3): sem isto o card era so uma LINHA no banco e o
          // WebContentsView - o que de fato custa frames - nunca nascia. O app RECUSA
          // o esquema data: ("only opens http(s) URLs"), por isso o harness serve a pagina.
          await window.browser.create(id, ${JSON.stringify(browserUrl)});
        }
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
    // PTY vivo, provider-AGNÓSTICO: qualquer filho do app classificado como
    // "cli" (sem `--type=`, não o main) é a CLI do agente — bash ou agente real.
    // A versão antiga exigia a string "bash" e abortava para qualquer provider
    // real (medido 2026-10-01).
    const shells = treePids(app.proc.pid).filter((pid) => readProc(pid)?.type === "cli");
    if (CARDS > 0 && shells.length === 0) {
      throw new Error(`nenhum processo CLI filho do app (provider "${PROVIDER}"): os cards nao tem PTY vivo`);
    }
    // CONFERE a tela antes de medir.
    // SEM `Page.reload`: os cards criados pela UI já estão vivos e na tela, e o
    // reload hoje volta pra HOME (nenhum board carregado) — medido 2026-10-01: a
    // versão que recarregava deixava o card "2" desconectado e abortava o GATE 2.
    // A injeção do `--no-webgl` é na PÁGINA VIVA (logo após `connectPage`), então
    // não precisa de documento novo.
    if (NO_WEBGL) {
      // A PROVA de que a sonda agiu: sem isto, "sem WebGL" poderia ser um run
      // normal lido como "o WebGL não custa nada".
      const blocked = await page.evalJs(`window.__webglBlocked ?? 0`);
      console.log(`[perf] --no-webgl: getContext(webgl) bloqueado ${blocked} vez(es)`);
    }
    // GATE 2 — a TELA: cada card precisa estar CONECTADO ao documento, com dims do
    // xterm, e INTERSECTANDO o viewport. `__getTerminalDims` prova que existe um
    // objeto Terminal no renderer, não que há pixels na tela; contagem de
    // `.xterm-helper-textarea` era a asserção errada (o app não a mantém neste
    // estado) — o que vale é conexão + interseção + dims, por card.
    const tela = JSON.parse(
      await page.evalJs(`(() => {
        const ids = ${JSON.stringify(idsCriados)};
        const out = [];
        for (const id of ids) {
          const el = document.querySelector('[data-card-id="' + id + '"]');
          const dims = window.__getTerminalDims?.(id) ?? null;
          if (!el) {
            out.push({ id, conectado: false, intersecta: false, dims: !!dims });
            continue;
          }
          const r = el.getBoundingClientRect();
          out.push({
            id,
            conectado: el.isConnected,
            intersecta: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
            dims: !!dims,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        }
        return JSON.stringify({ innerW: innerWidth, innerH: innerHeight, cards: out });
      })()`),
    );
    console.log(`[perf] TELA: ${JSON.stringify(tela)}`);
    if (CARDS > 0) {
      const ruins = tela.cards.filter((c) => !c.conectado || !c.intersecta || !c.dims);
      if (ruins.length > 0) {
        throw new Error(`cards fora da tela: ${JSON.stringify(ruins)}`);
      }
    }
    if (tela.innerW === 0 || tela.innerH === 0) {
      throw new Error(`viewport sem dimensao (${tela.innerW}x${tela.innerH}): a janela nao esta sendo pintada`);
    }
    console.log(`[perf] VERIFICADO: ${vivos.length} card(s) no store, ${shells.length} shell(s) vivo(s)`);
    await delay(4000); // os shells sobem
    if (!REAL_IDLE || EXEC !== null) {
      for (const cardId of idsCriados) {
        const cmd = EXEC ?? `node ${FIXTURE} ${RATE}`;
        await page.evalJs(`window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify(cmd + "\r")}, "human").then(() => true)`);
      }
    }
    await delay(4000); // a TUI sintética começa a repintar

    if (process.env.PERF_DEBUG) {
      console.log(`[perf:debug] main=${app.proc.pid} vivos=${app.proc.exitCode === null} arvore=${treePids(app.proc.pid).length}`);
    }
    if (FOCUS_CARDS > 0) {
      const focados = await page.evalJs(`(() => {
        const tas = [...document.querySelectorAll(".xterm-helper-textarea")].slice(0, ${FOCUS_CARDS});
        for (const ta of tas) ta.focus();
        const ativo = document.activeElement;
        return { pedidos: ${FOCUS_CARDS}, focados: tas.length, ativoEhTextarea: !!ativo && ativo.tagName === "TEXTAREA" };
      })()`);
      console.log(`[perf] FOCO: ${JSON.stringify(focados)}`);
    }

    // VISIBILIDADE E DOM, medidos JUNTO do custo (task 27e13021): o Chromium
    // estrangula pintura de janela ocluída/em segundo plano, e os terminais podem
    // nem estar no DOM quando estão fora de tela. Sem estes dois números, uma
    // queda de renderer pode ser "conserto" quando é a janela atrás de outra.
    const visibilidade = await page.evalJs(`JSON.stringify({
      hidden: document.hidden,
      state: document.visibilityState,
      textareas: document.querySelectorAll(".xterm-helper-textarea").length,
      canvas: document.querySelectorAll("canvas").length,
    })`);
    console.log(`[perf] DOM/visibilidade no momento da amostra: ${visibilidade}`);

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
        cmd: now.cmd,
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
    if (PER_PROC) {
      console.log("\n[perf] PER-PROC (rss desc) — separa a CLI do agente do shim stellar-mcp:");
      for (const r of [...rows].sort((a, b) => b.rssMb - a.rssMb)) {
        console.log(`  ${String(Math.round(r.rssMb)).padStart(6)} MB  ${r.type.padEnd(14)} ${r.cmd}`);
      }
    }
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
