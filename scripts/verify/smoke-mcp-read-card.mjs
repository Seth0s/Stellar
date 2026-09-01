// DESIGN-BACKLOG.md item 58, M1 — the only way to check on a spawned
// agent used to be `snapshot`, a screenshot: OCR-only, ordinal-magnitude
// more tokens, loses anything scrolled out of the viewport. `read_card`
// returns the real xterm.js scrollback as plain text instead.
//
// Proves two things a screenshot-based check couldn't: (1) the returned
// text is the REAL content, not an image, and (2) it includes lines that
// scrolled out of the visible viewport — real scrollback, not just
// what's currently painted on screen.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9488;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-read-card", import.meta.url).pathname;

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "MCP Read Card Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  // Um marker no topo (vai sair da viewport) e um no fim (fica visível) —
  // prova real de scrollback, não só do que está pintado na tela agora.
  const TOP_MARKER = "TOPO-SCROLLBACK-88213";
  const BOTTOM_MARKER = "FUNDO-VISIVEL-55107";
  await page.evalJs(`window.pty.write(${JSON.stringify(bashCardId)}, ${JSON.stringify(`echo ${TOP_MARKER}\r`)})`);
  await new Promise((r) => setTimeout(r, 300));
  // Linhas suficientes pra empurrar o marker do topo pra fora da viewport
  // padrão do terminal (24 linhas).
  await page.evalJs(`window.pty.write(${JSON.stringify(bashCardId)}, ${JSON.stringify("for i in $(seq 1 40); do echo linha-de-enchimento-$i; done\r")})`);
  await new Promise((r) => setTimeout(r, 500));
  await page.evalJs(`window.pty.write(${JSON.stringify(bashCardId)}, ${JSON.stringify(`echo ${BOTTOM_MARKER}\r`)})`);
  await new Promise((r) => setTimeout(r, 500));

  const notOnScreenPayload = await page.evalJs(`
    (() => {
      const card = document.querySelector('.terminal-card');
      return JSON.stringify(card?.textContent.includes(${JSON.stringify(TOP_MARKER)}) ?? null);
    })()
  `);
  check("checagem de sanidade: o marker do topo já saiu da viewport visível do DOM", JSON.parse(notOnScreenPayload), false);

  const readResult = await toolJson("read_card", { target: bashCardId });
  check("read_card resolve ok", readResult.ok, true);
  check("...devolve TEXTO puro, não uma imagem (é uma string com conteúdo real)", typeof readResult.text === "string" && readResult.text.length > 0, true);
  check("...inclui o marker do FUNDO (visível na tela)", readResult.text.includes(BOTTOM_MARKER), true);
  check("...e inclui o marker do TOPO mesmo tendo saído da viewport — scrollback real, não só a tela", readResult.text.includes(TOP_MARKER), true);

  // `lines` — só as últimas N linhas, sem o marker do topo.
  const tailResult = await toolJson("read_card", { target: bashCardId, lines: 5 });
  check("read_card com lines:5 ainda inclui o marker do fundo", tailResult.text.includes(BOTTOM_MARKER), true);
  check("...mas NÃO inclui o marker do topo (ficou fora da janela de 5 linhas)", tailResult.text.includes(TOP_MARKER), false);

  // Card inexistente — erro honesto, não uma exceção não tratada.
  const missingResult = await toolJson("read_card", { target: "nao-existe-999" });
  check("read_card num card inexistente reporta ok:false", missingResult.ok, false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
