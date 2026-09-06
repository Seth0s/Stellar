// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 5 — política de
// falha. Same architectural boundary as peça 4 (explicit user decision):
// this app doesn't retry or reassign anything on its own — `update_task`'s
// `incrementRetry`/`attemptedProvider` are bookkeeping for an EXTERNAL
// orchestrator's own retry/reassignment loop. This test plays that
// orchestrator's role using only real primitives already built (M1/M4,
// peça 1, peça 3): spawn a real agent, kill it without ever calling
// `report`, detect the failure for real (card_status exited + read_report
// ok:false — not a mocked signal), retry once, then reassign to a
// genuinely different provider — and confirm the task's bookkeeping
// reflects all of it.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-tasks-failure-${CDP_PORT}`, import.meta.url).pathname;

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

async function spawnBashAgent(page, requesterId, reason) {
  const spawnPromise = callTool("spawn_agent", { provider: "bash", callerCardId: requesterId, reason });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const payload = JSON.parse((await spawnPromise).content[0].text);
  await new Promise((r) => setTimeout(r, 300));
  return payload.cardId;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "MCP Tasks Failure Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  // Tarefa nasce atribuída a "bash" (bash faz o papel de provider real
  // nesta simulação — comportamento de saída sem report é idêntico ao de
  // qualquer provider real que morre sem chamar `report`).
  const createPayload = await toolJson("create_task", { prompt: "tarefa que vai falhar de propósito", provider: "bash" });
  const taskId = createPayload.taskId;
  check(
    "task nasce com attemptedProviders já incluindo o provider inicial",
    JSON.stringify((await toolJson("get_task", { taskId })).task?.attemptedProviders),
    JSON.stringify(["bash"]),
  );

  // --- Tentativa 1: spawna, mata sem reportar, detecta a falha de verdade ---
  const attempt1CardId = await spawnBashAgent(page, bashCardId, "tentativa 1");
  await toolJson("update_task", { taskId, cardId: attempt1CardId, status: "running" });

  await page.evalJs(`window.pty.kill(${JSON.stringify(attempt1CardId)})`);
  await new Promise((r) => setTimeout(r, 500));

  const statusAfterDeath1 = await toolJson("card_status", { target: attempt1CardId });
  const reportAfterDeath1 = await toolJson("read_report", { target: attempt1CardId });
  check("tentativa 1: card_status real confirma 'exited'", statusAfterDeath1.status, "exited");
  check("...e read_report real confirma que NUNCA chegou report (ok:false) — falha genuína, não simulada", reportAfterDeath1.ok, false);

  // Orquestrador (este teste) decide: retry.
  await toolJson("update_task", { taskId, status: "failed", incrementRetry: true, cardId: null });
  const afterRetry1 = (await toolJson("get_task", { taskId })).task;
  check("depois da 1ª falha, retryCount é 1", afterRetry1.retryCount, 1);
  check("...status reflete 'failed'", afterRetry1.status, "failed");
  check("...cardId foi desanexado (o card antigo não serve mais)", afterRetry1.cardId, null);

  // --- Tentativa 2 (retry, mesmo provider): mesma falha de novo ---
  const attempt2CardId = await spawnBashAgent(page, bashCardId, "tentativa 2 (retry)");
  await toolJson("update_task", { taskId, cardId: attempt2CardId, status: "running" });
  await page.evalJs(`window.pty.kill(${JSON.stringify(attempt2CardId)})`);
  await new Promise((r) => setTimeout(r, 500));

  const reportAfterDeath2 = await toolJson("read_report", { target: attempt2CardId });
  check("tentativa 2 (retry): também falha de verdade sem report", reportAfterDeath2.ok, false);

  // Orquestrador decide: limite de retry atingido, reatribuir a um
  // provider DIFERENTE do que falhou (a tese cross-provider da própria
  // auditoria) — "claude" real nesta máquina, não um provider inventado.
  await toolJson("update_task", { taskId, status: "failed", incrementRetry: true, attemptedProvider: "claude", cardId: null });
  const afterRetry2 = (await toolJson("get_task", { taskId })).task;
  check("depois da 2ª falha, retryCount é 2", afterRetry2.retryCount, 2);
  check("...attemptedProviders agora inclui 'claude' (reatribuição pra provider diferente)", JSON.stringify(afterRetry2.attemptedProviders), JSON.stringify(["bash", "claude"]));

  const finalList = await toolJson("list_tasks", {});
  const finalTask = finalList.tasks.find((t) => t.id === taskId);
  check("list_tasks reflete o estado final completo — retryCount e attemptedProviders visíveis", JSON.stringify({ retryCount: finalTask.retryCount, attemptedProviders: finalTask.attemptedProviders, status: finalTask.status }), JSON.stringify({ retryCount: 2, attemptedProviders: ["bash", "claude"], status: "failed" }));

  page.close();
} finally {
  await stopApp(app);
}
finish();
