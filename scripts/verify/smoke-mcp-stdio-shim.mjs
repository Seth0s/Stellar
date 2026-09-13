// Pedido ao vivo (2026-09-01): "é preciso registrar o cursor como
// provider, e o antigravity(gemini)". Nenhuma das duas CLIs aceita
// registro efêmero de MCP — confirmado lendo o `--help` real dos binários
// instalados — e config persistente não consegue carregar nem a porta
// efêmera do servidor HTTP nem o `?card=<id>` por card.
//
// `resources/bin/stellar-mcp` é a saída: um servidor MCP em stdio que é um
// proxy puro pro HTTP, registrado uma vez como comando estável e que
// descobre porta e identidade no ambiente que o processo do card já tem.
//
// Este arquivo exercita o shim como um cliente MCP de verdade faria — um
// processo filho, JSON-RPC por linha no stdin/stdout — contra uma
// instância real da app. Nada de mock: se o proxy quebrar o framing, o
// handshake ou a identidade, quebra aqui.
import { spawn } from "node:child_process";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-stdio-shim-${CDP_PORT}`, import.meta.url).pathname;
const SHIM = new URL("../../resources/bin/stellar-mcp", import.meta.url).pathname;

let nextRpcId = 1;
async function httpTool(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(JSON.parse(line).result.content[0].text);
}

/** Um cliente MCP em stdio mínimo, falando com o shim como processo filho.
 * `viaShell` executa o arquivo pelo shebang (`#!/bin/sh`), como uma CLI
 * de agente faz — é a única forma de exercitar a linha 2 do polyglot
 * (o `exec` pro node e a guarda do literal `${env:AGENT_CANVAS_NODE}`). */
function startShim(env, { viaShell = false } = {}) {
  const child = spawn(viaShell ? SHIM : process.execPath, viaShell ? [] : [SHIM], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = new Map();
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = waiters.get(msg.id);
      if (waiter) {
        waiters.delete(msg.id);
        waiter(msg);
      }
    }
  });
  let id = 1;
  return {
    child,
    get stderr() {
      return stderr;
    },
    request(method, params) {
      const rpcId = id++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout em ${method}; stderr: ${stderr}`)), 20_000);
        waiters.set(rpcId, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

async function hasModal(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.modal'))`));
}
async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`,
    ),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
let shim = null;
let offline = null;
let literal = null;
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Shim stdio");
  await new Promise((r) => setTimeout(r, 600));

  const bashId = (await httpTool("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  // --- o shim como um card real o veria: URL + identidade no ambiente ---
  shim = startShim({ AGENT_CANVAS_MCP_URL: MCP_URL, AGENT_CANVAS_CARD_ID: bashId });

  const init = await shim.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  check("o handshake MCP passa pelo shim", init.result?.serverInfo?.name, "stellar");
  shim.notify("notifications/initialized", {});

  const list = await shim.request("tools/list", {});
  const shimTools = (list.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list volta o conjunto inteiro pelo stdio", shimTools.length > 20, true);

  // A prova de que é proxy e não uma segunda lista escrita à mão: bate
  // exatamente com a que o servidor HTTP expõe. Se alguém acrescentar uma
  // tool nova em mcp-server.ts, ela aparece aqui de graça.
  const httpRes = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "tools/list", params: {} }),
  });
  const httpText = await httpRes.text();
  const httpLine = httpText.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? httpText;
  const httpTools = (JSON.parse(httpLine).result?.tools ?? []).map((t) => t.name).sort();
  check("...idêntico ao do servidor HTTP (é proxy, não uma segunda lista)", JSON.stringify(shimTools), JSON.stringify(httpTools));

  const called = await shim.request("tools/call", { name: "list_cards", arguments: {} });
  const payload = JSON.parse(called.result.content[0].text);
  check("tools/call de verdade atravessa o shim", payload.ok, true);
  check("...e enxerga o board real", payload.cards.some((c) => c.id === bashId), true);

  // --- fora do Stellar: degrada, não quebra ---
  // Um humano que rode `cursor-agent` fora da app tem o mesmo registro no
  // config global apontando pra este script. Ele precisa completar o
  // handshake e dizer "nenhuma ferramenta", nunca morrer no boot e virar
  // uma linha vermelha sem explicação na CLI do agente.
  offline = startShim({ AGENT_CANVAS_MCP_URL: "", AGENT_CANVAS_CARD_ID: "" });
  const offInit = await offline.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check("sem a app por perto, o handshake ainda completa", offInit.result?.serverInfo?.name, "stellar (offline)");
  const offList = await offline.request("tools/list", {});
  check("...com uma lista de ferramentas vazia em vez de um crash", (offList.result?.tools ?? []).length, 0);
  offline.stop();

  // --- fora do Stellar, pelo cursor: o literal `${env:VAR}` ---
  // Medido 2026-09-13: quando a variável não existe no processo do cursor,
  // a interpolação da entrada NÃO vira vazio — chega o literal. Sem a
  // guarda (linha 2 do shim pro NODE, `fromEnv` pro resto) isso era
  // `exec: ${env:AGENT_CANVAS_NODE}: not found` e uma linha vermelha em
  // toda sessão do usuário fora de um card.
  literal = startShim(
    {
      AGENT_CANVAS_MCP_URL: "${env:AGENT_CANVAS_MCP_URL}",
      AGENT_CANVAS_CARD_ID: "${env:AGENT_CANVAS_CARD_ID}",
      AGENT_CANVAS_NODE: "${env:AGENT_CANVAS_NODE}",
    },
    { viaShell: true },
  );
  const litInit = await literal.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check("com os literais `${env:...}` não expandidos, o handshake ainda completa offline", litInit.result?.serverInfo?.name, "stellar (offline)");
  const litList = await literal.request("tools/list", {});
  check("...e a lista é vazia, não um fetch numa URL inválida", (litList.result?.tools ?? []).length, 0);
  literal.stop();

  // --- identidade: o ponto todo do shim ---
  // Liga o modo autônomo e chama uma tool que exige saber QUEM está
  // chamando, SEM passar callerCardId. Se o shim não carimbasse o
  // `?card=` vindo do ambiente, isto cairia no modal de consentimento —
  // que é exatamente o bug que o modo autônomo tinha.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencil = await centerOf(page, '.board-row.active button[data-role="edit-session"]');
  await page.click(pencil.x, pencil.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));
  const cancelar = JSON.parse(
    await page.evalJs(
      `(() => { const b=[...document.querySelectorAll('.modal-actions button')].find(x=>x.textContent.trim()==='Cancelar'); const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`,
    ),
  );
  await page.click(cancelar.x, cancelar.y);
  await new Promise((r) => setTimeout(r, 400));
  check("modo autônomo ligado, tela limpa antes da checagem", await hasModal(page), false);

  const openPromise = shim.request("tools/call", {
    name: "open_url",
    arguments: { url: "data:text/html,<h1>shim</h1>", reason: "identidade pelo ambiente" },
  });
  await new Promise((r) => setTimeout(r, 900));
  check("o shim carrega a identidade do card — nenhum modal aparece", await hasModal(page), false);
  const opened = JSON.parse((await openPromise).result.content[0].text);
  check("...e a chamada resolve ok:true sozinha", opened.ok, true);
} finally {
  shim?.stop();
  offline?.stop();
  literal?.stop();
  finish();
  await stopApp(app);
}
