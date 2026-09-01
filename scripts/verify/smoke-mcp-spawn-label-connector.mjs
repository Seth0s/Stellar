// DESIGN-BACKLOG.md item 62 — spawn_agent now accepts `label` (same
// free-text field a human sets by renaming a card's tag), and every real
// spawn (autoApprove path and human-approved-via-modal path alike) now
// auto-creates a connector with kind:"spawned" from the requester card to
// the new card — a real lineage record, distinct from the purely
// decorative hand-drawn connectors and from the orchestrator-only
// 'depends'/'context' tags, none of which drive the app's own dispatch.
//
// Verifies both, end-to-end, with no mock:
// 1. spawn_agent({ label: "..." }) approved via the consent modal →
//    the new card's persisted `label` matches what was requested.
// 2. list_connectors shows a kind:"spawned" connector from callerCardId
//    to the new card's id immediately after.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9482;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-spawn-label-connector", import.meta.url).pathname;

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "MCP Spawn Label+Connector Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  // 1. modal-approved path — human clicks "Permitir" in the consent modal.
  const spawnPromise = callTool("spawn_agent", {
    provider: "claude",
    label: "Pesquisador Fiscal",
    callerCardId: bashCardId,
    reason: "smoke test item 62",
  });
  await new Promise((r) => setTimeout(r, 500));

  const modalCommand = await page.evalJs(`
    (() => {
      const el = document.querySelector('.modal-body, .modal') ;
      return JSON.stringify(document.body.innerText.includes('Pesquisador Fiscal'));
    })()
  `);
  check("o modal de aprovação mostra o label pedido antes do humano aprovar", JSON.parse(modalCommand), true);

  await clickModalButton(page, "Permitir");
  const spawnPayload = await spawnPromise.then((r) => JSON.parse(r.content[0].text));
  check("spawn_agent com label resolve ok com um cardId", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);

  await new Promise((r) => setTimeout(r, 500));
  const newCard = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const c = cards.find((x) => x.id === ${JSON.stringify(spawnPayload.cardId)});
        return JSON.stringify(c ? { label: c.label } : null);
      })()
    `),
  );
  check("o card nasce com o label pedido persistido", newCard?.label, "Pesquisador Fiscal");

  const connectorsPayload = await toolJson("list_connectors", {});
  const spawnedConnector = connectorsPayload.connectors.find(
    (c) => c.fromCardId === bashCardId && c.toCardId === spawnPayload.cardId,
  );
  check("existe um connector do requester pro novo card", Boolean(spawnedConnector), true);
  check("...e seu kind é 'spawned', auto-marcado pelo app", spawnedConnector?.kind, "spawned");

  // 2. same card, spawn de novo sem label — não deveria virar string vazia
  // nem quebrar o describeAsk (regressão do campo opcional).
  const spawnPromiseNoLabel = callTool("spawn_agent", { provider: "bash", callerCardId: bashCardId, reason: "sem label" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayloadNoLabel = await spawnPromiseNoLabel.then((r) => JSON.parse(r.content[0].text));
  check("spawn_agent sem label continua funcionando normalmente", spawnPayloadNoLabel.ok && typeof spawnPayloadNoLabel.cardId === "string", true);

  await new Promise((r) => setTimeout(r, 500));
  const connectorsPayload2 = await toolJson("list_connectors", {});
  const spawnedConnector2 = connectorsPayload2.connectors.find(
    (c) => c.fromCardId === bashCardId && c.toCardId === spawnPayloadNoLabel.cardId,
  );
  check("...e também ganha seu próprio connector 'spawned'", spawnedConnector2?.kind, "spawned");

  page.close();
} finally {
  await stopApp(app);
}
finish();
