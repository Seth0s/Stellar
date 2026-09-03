// Sticky item "card_status idle" (2026-09-03) — "card_status nunca
// retorna idle, só waiting/running/exited... o agente não tem noção que
// o card entrou em X, ele precisa saber disso... um evento tipo
// card_status_changed que dispare notificação automática pro agente que
// fez o spawn_agent". Verifies BOTH halves: `card_status` reports 'idle'
// (not just 'running') for a card that's genuinely gone quiet, and the
// spawner gets a real, visible notification written into its OWN
// terminal the moment that transition happens — no polling on the
// spawner's side, no new push channel invented, just `writeToCard`
// reused (the same mechanism `send_to_card` already uses).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9614;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-card-status-idle", import.meta.url).pathname;

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

  // spawn_agent a partir do spawner — grava a lineage 'spawned' real
  // (item 62) que `notifySpawnerOfIdleCard` usa pra achar pra quem
  // notificar.
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

  // Espera passar do threshold de idle (5s) + pelo menos 1 tick do
  // poller (2s) — um bash real sentado no prompt não produz NENHUM
  // output sozinho, cenário exatamente real de "ocioso".
  await new Promise((r) => setTimeout(r, 8000));

  const idleStatus = await toolJson("card_status", { target: childCardId });
  check("card_status reporta 'idle' depois do card ficar quieto de verdade", idleStatus.status, "idle");

  // O spawner (o card que chamou spawn_agent) deve ter recebido a
  // notificação real, escrita no PRÓPRIO terminal dele — não é preciso
  // fazer polling nenhum do lado de quem spawnou.
  const spawnerText = await toolJson("read_card", { target: spawnerCardId, lines: 20 });
  check(
    "o spawner recebeu a notificação real de 'ficou ocioso' escrita no próprio terminal",
    /sistema/i.test(spawnerText.text) && /ocioso/i.test(spawnerText.text),
    true,
  );

  // Confirma que o card ORIGINAL (o próprio spawner, ainda com atividade
  // recente da escrita acima) continua 'running', não 'idle' — a
  // notificação em si é uma escrita real no PTY, então reseta a
  // atividade dele por conta própria; só checa que o estado por card é
  // mesmo independente.
  const spawnerStatus = await toolJson("card_status", { target: spawnerCardId });
  check("o card do spawner (que acabou de receber a notificação) continua 'running', não 'idle'", spawnerStatus.status, "running");

  page.close();
} finally {
  await stopApp(app);
}
finish();
