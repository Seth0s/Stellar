// DESIGN-BACKLOG.md item 58, M3 — `spawn_agent`'s MCP schema had no
// `model`/`effort` field, so a card always spawned on its provider's
// default and had to be reconfigured afterward via two more `send_to_card`
// round-trips (`/model`, `/effort`) — a real window where the agent is
// already alive on the wrong model before those commands land.
//
// Verifies the model now travels end-to-end at spawn time: MCP schema →
// message-bus BusRequest → onSpawnAgentRequest → renderer's
// spawnAgentFor → the card row persisted by store.ts — checked via
// `store.list` right after creation, with no `/model` command sent.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9481;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-spawn-model", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "MCP Spawn Model Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  const spawnPromise = callTool("spawn_agent", { provider: "claude", model: "sonnet", callerCardId: bashCardId, reason: "smoke test M3" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent com model explícito resolve ok com um cardId", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);

  await new Promise((r) => setTimeout(r, 500));
  const newCard = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const c = cards.find((x) => x.id === ${JSON.stringify(spawnPayload.cardId)});
        return JSON.stringify(c ? { provider: c.provider, model: c.model } : null);
      })()
    `),
  );
  check("o card nasce provider 'claude'", newCard?.provider, "claude");
  check("...e já com model 'sonnet' persistido desde a criação, sem nenhum /model enviado", newCard?.model, "sonnet");

  page.close();
} finally {
  await stopApp(app);
}
finish();
