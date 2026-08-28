// DESIGN-BACKLOG.md item 28 — Gemini como provider terminal-spawnável de
// verdade (ProviderId, providers.ts), com MCP `spawn_agent` aceitando
// "gemini" no enum. `gemini` não está instalado nesta máquina (confirmado
// via `which gemini`), então a prova real possível aqui é: o caminho
// inteiro funciona igual a claude/codex/cursor até o ponto exato onde um
// binário ausente já falha hoje pra QUALQUER provider — "binary_not_found"
// honesto, não um crash nem um "ok" mentiroso. Cobre os dois pontos de
// entrada: UI (rail → popover → provider picker) e MCP (spawn_agent).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9450;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-provider-gemini", import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
}
async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`modal button "${label}" not found`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Provider Gemini Teste");
  await new Promise((r) => setTimeout(r, 600));

  // ---- 1. UI: gemini aparece no provider picker do popover de terminal ----
  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const geminiBtnCoords = await centerOf(page, '.provider-picker-btn[title="gemini"]');
  check("gemini aparece no provider picker do popover de terminal", geminiBtnCoords !== null, true);
  await page.click(geminiBtnCoords.x, geminiBtnCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarBtn.x, criarBtn.y);
  await new Promise((r) => setTimeout(r, 1000));

  const spawnErrorText = await page.evalJs(`document.querySelector('.terminal-card-exited')?.textContent`);
  check(
    "criar um terminal com provider gemini (binário ausente nesta máquina) falha de forma honesta, sem crash",
    typeof spawnErrorText === "string" && spawnErrorText.length > 0,
    true,
  );

  // ---- 2. MCP: spawn_agent aceita "gemini" no enum, consent flow real,
  // resolve ok com um cardId (a falha de binário é DENTRO do card, não uma
  // rejeição da própria chamada MCP — mesmo comportamento de qualquer
  // provider ausente hoje) ----
  const cardsBefore = await page.evalJs(`document.querySelectorAll('.terminal-card').length`);
  const bashCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal').id);
      })()
    `),
  );

  const spawnPromise = callTool("spawn_agent", { provider: "gemini", callerCardId: bashCardId, reason: "testar provider gemini via MCP" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent MCP aceita provider gemini e resolve ok com um cardId", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  const cardsAfter = await page.evalJs(`document.querySelectorAll('.terminal-card').length`);
  check("um novo terminal card real existe depois do spawn_agent(gemini) aprovado", cardsAfter, cardsBefore + 1);

  page.close();
} finally {
  await stopApp(app);
}
finish();
