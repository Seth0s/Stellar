// DESIGN-BACKLOG.md item 61 — send_to_card had no caller-identity param at
// all (unlike open_url/spawn_agent/spawn_card), so a message delivered
// cross-card carried no attribution — achado ao vivo, reportado
// diretamente pelo usuário: uma mensagem chegou sem rótulo de origem,
// causando confusão real sobre quem estava "falando".
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9602;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-send-sender-label", import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
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
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}
/** Board não é autônomo neste teste — todo spawn_agent mostra
 * AgentAskModal. Dispara sem esperar, clica "Permitir", só então espera
 * a resposta — mesmo padrão de smoke-mcp.mjs. */
async function spawnAndApprove(page, args) {
  const promise = callTool("spawn_agent", args);
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const result = JSON.parse((await promise).content[0].text);
  return result;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Send Sender Label Teste");
  await new Promise((r) => setTimeout(r, 500));

  const cards = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = cards.cards.find((c) => c.kind === "terminal").id;

  // Segundo card bash real — vai ser o "remetente" com identidade
  // própria (ordinal "Bash 2°", mesmo rótulo do AgentAskModal).
  const spawnBash2 = await spawnAndApprove(page, { provider: "bash", callerCardId: bashCardId, reason: "segundo remetente" });
  check("segundo card bash real foi criado", spawnBash2.ok && typeof spawnBash2.cardId === "string", true);
  const senderCardId = spawnBash2.cardId;
  await new Promise((r) => setTimeout(r, 500));

  // Card claude real — alvo pra testar o prefixo (bash como alvo NUNCA
  // recebe prefixo, quebraria o comando; só cards de prosa recebem).
  const spawnClaude = await spawnAndApprove(page, { provider: "claude", callerCardId: bashCardId, reason: "alvo pra receber a mensagem prefixada" });
  check("card claude real foi criado como alvo", spawnClaude.ok && typeof spawnClaude.cardId === "string", true);
  const claudeTargetId = spawnClaude.cardId;
  await new Promise((r) => setTimeout(r, 1500));

  await page.evalJs(`
    (() => {
      window.__bashChunks = '';
      window.__claudeChunks = '';
      window.pty.onData((id, data) => {
        if (id === ${JSON.stringify(bashCardId)}) window.__bashChunks += data;
        if (id === ${JSON.stringify(claudeTargetId)}) window.__claudeChunks += data;
      });
    })()
  `);

  // 1) Alvo BASH, com callerCardId — prefixo suprimido de propósito
  // (quebraria o comando), comando ainda executa normalmente.
  const toBash = await toolJson("send_to_card", { target: bashCardId, text: "echo sem-prefixo-$((1+1))", callerCardId: senderCardId });
  check("send_to_card pra alvo bash resolve ok:true", toBash.ok, true);
  await new Promise((r) => setTimeout(r, 800));
  const bashChunks = await page.evalJs(`window.__bashChunks`);
  check("...alvo bash NUNCA recebe prefixo (quebraria o comando)", bashChunks.includes("[de:"), false);
  check("...e o comando ainda executa normalmente", bashChunks.includes("sem-prefixo-2"), true);

  // 2) Alvo CLAUDE, SEM callerCardId — comportamento antigo intacto.
  const withoutSender = await toolJson("send_to_card", { target: claudeTargetId, text: "Responda só 'recebido1' e nada mais." });
  check("send_to_card SEM callerCardId ainda funciona (ok:true)", withoutSender.ok, true);
  await new Promise((r) => setTimeout(r, 1500));
  const claudeChunks1 = await page.evalJs(`window.__claudeChunks`);
  check("...e o texto entregue NÃO tem prefixo de remetente (comportamento antigo intacto)", claudeChunks1.includes("[de:"), false);

  await page.evalJs(`window.__claudeChunks = ''`);

  // 3) Alvo CLAUDE, COM callerCardId (bash 2°) — texto entregue carrega
  // o rótulo real de origem.
  const withSender = await toolJson("send_to_card", {
    target: claudeTargetId,
    text: "Responda só 'recebido2' e nada mais.",
    callerCardId: senderCardId,
  });
  check("send_to_card COM callerCardId resolve ok:true", withSender.ok, true);
  await new Promise((r) => setTimeout(r, 1500));
  const claudeChunks2 = await page.evalJs(`window.__claudeChunks`);
  check("...e o texto entregue carrega o rótulo real de origem ('Bash 2°', não o id bruto)", claudeChunks2.includes("[de: Bash 2°]"), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
