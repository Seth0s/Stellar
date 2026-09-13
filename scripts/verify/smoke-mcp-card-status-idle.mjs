// Sticky item "card_status idle" (2026-09-03) — "card_status nunca
// retorna idle, só waiting/running/exited... o agente não tem noção que
// o card entrou em X, ele precisa saber disso". Verifies the remaining
// signal: `card_status` reports 'idle' (not just 'running') for a card
// that's genuinely gone quiet.
//
// The OS popup half (`notifyIdleCard` / `debug:last-idle-notification`)
// was removed on purpose: the owner does not want the human interrupted
// when an agent card goes idle. Polling `card_status` is the channel.
// Do not resurrect a lastIdleNotification probe here — that hook is gone
// with the popup; asserting on it would fail in silence for the wrong
// reason.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-card-status-idle-${CDP_PORT}`, import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Card Status Idle Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  const spawnerCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  // spawn_agent a partir do spawner — grava a lineage 'spawned' real.
  const spawnPromise = callTool("spawn_agent", { provider: "bash", callerCardId: spawnerCardId, reason: "smoke test idle" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnResult = JSON.parse((await spawnPromise).content[0].text);
  check("segundo bash real criado pelo spawn_agent", typeof spawnResult.cardId === "string", true);
  const childCardId = spawnResult.cardId;

  // Recém-criado, ainda dentro do IDLE_THRESHOLD_MS (5s) — deve reportar
  // 'running', não 'idle' nem 'exited'.
  const freshStatus = await toolJson("card_status", { target: childCardId });
  check("card_status logo após o spawn ainda é 'running', não 'idle' de cara", freshStatus.status, "running");

  // Espera passar do threshold de idle (5s). card_status calcula idle
  // na hora (sem poller de popup). Um bash real sentado no prompt não
  // produz NENHUM output sozinho — cenário exatamente real de "ocioso".
  await new Promise((r) => setTimeout(r, 8000));

  const idleStatus = await toolJson("card_status", { target: childCardId });
  check("card_status reporta 'idle' depois do card ficar quieto de verdade", idleStatus.status, "idle");

  page.close();
} finally {
  await stopApp(app);
}
finish();
