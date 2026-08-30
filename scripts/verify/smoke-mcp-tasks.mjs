// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 3 — a task's
// identity used to be the cardId itself: closing the card (or restarting
// the app) lost all record of it, so an interrupted orchestration had no
// way to resume, only start over. New `tasks` table (store.ts) + MCP
// tools (create_task/update_task/list_tasks/get_task) give a task its
// own id, independent of any card.
//
// Two real things get proven here, not one: (1) closing the card doesn't
// touch the task row (same running app instance), and (2) the task row
// really is durable on disk — a genuinely SEPARATE Electron process,
// launched against the SAME --user-data-dir after the first one fully
// exits, still lists it via the real MCP server. cdp-client.mjs's own
// `startApp` always wipes `userDataDir` first (deliberately, so normal
// smoke runs start clean) — this test needs the opposite for its second
// launch, so it spawns that one directly instead, same launch shape
// minus the wipe.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ELECTRON_BIN = fileURLToPath(new URL("../../node_modules/.bin/electron", import.meta.url));
const ELECTRON_MAIN = "out/main/index.js";

const CDP_PORT = 9516;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-tasks", import.meta.url).pathname;

/** Same launch shape as cdp-client.mjs's `startApp`, minus the
 * `rmSync(userDataDir)` wipe — this is the one case that needs the
 * previous instance's on-disk state to still be there. */
async function startAppKeepingData({ cdpPort, userDataDir, timeoutMs = 15000 }) {
  const proc = spawn(ELECTRON_BIN, [ELECTRON_MAIN, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, AGENT_CANVAS_REMOTE_PORT: String(cdpPort + 30000), AGENT_CANVAS_MCP_PORT: String(cdpPort + 40000) },
  });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) return { proc, cdpPort, stderr: () => stderr };
    } catch {
      // Not up yet.
    }
    await delay(200);
  }
  proc.kill("SIGKILL");
  throw new Error(`second instance didn't come up on port ${cdpPort} within ${timeoutMs}ms\nstderr so far:\n${stderr}`);
}

let nextRpcId = 1;
async function mcpCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function callTool(url, name, args) {
  const rpc = await mcpCall(url, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(url, name, args) {
  const result = await callTool(url, name, args);
  return JSON.parse(result.content[0].text);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
let taskId;
let bashCardId;
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "MCP Tasks Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson(MCP_URL, "list_cards", {});
  bashCardId = listPayload.cards[0].id;

  const createPayload = await toolJson(MCP_URL, "create_task", {
    prompt: "tarefa de teste — sobreviver ao fechamento do card e a um restart",
    provider: "bash",
    cardId: bashCardId,
  });
  check("create_task resolve ok com um taskId", createPayload.ok && typeof createPayload.taskId === "string", true);
  taskId = createPayload.taskId;

  const afterCreate = await toolJson(MCP_URL, "get_task", { taskId });
  check("a task nasce com status 'running' (cardId foi dado na criação)", afterCreate.task?.status, "running");
  check("...com o cardId certo", afterCreate.task?.cardId, bashCardId);

  // "Fechar o card" — remove a linha persistida do card, sem tocar na
  // task (deleteCard é o que qualquer caminho de fechamento real —
  // botão da UI incluído — acaba chamando).
  await page.evalJs(`window.store.delete(${JSON.stringify(bashCardId)})`);
  await new Promise((r) => setTimeout(r, 300));

  const afterCardClosed = await toolJson(MCP_URL, "get_task", { taskId });
  check("depois de fechar o card, a task AINDA existe (não foi perdida)", afterCardClosed.ok, true);
  check("...com o mesmo status", afterCardClosed.task?.status, "running");
  check("...e o mesmo prompt/provider intactos", afterCardClosed.task?.prompt?.includes("sobreviver"), true);

  const listAfterClose = await toolJson(MCP_URL, "list_tasks", {});
  check("list_tasks ainda lista essa task depois do card fechado", listAfterClose.tasks?.some((t) => t.id === taskId), true);

  page.close();
} finally {
  await stopApp(app);
}

// Segunda instância REAL do Electron, MESMO --user-data-dir, depois da
// primeira ter encerrado de verdade — simula reabrir o app depois de um
// restart de verdade, não um atalho lendo o arquivo sqlite por fora.
const app2 = await startAppKeepingData({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const restarted = await toolJson(MCP_URL, "get_task", { taskId });
  check("depois de um restart REAL do app (segundo processo Electron, mesmo perfil), get_task ainda acha a task", restarted.ok, true);
  check("...com o status real preservado", restarted.task?.status, "running");
  check("...e o cardId antigo ainda registrado, mesmo o card já não existindo mais", restarted.task?.cardId, bashCardId);

  const listRestarted = await toolJson(MCP_URL, "list_tasks", {});
  check("list_tasks depois do restart ainda lista a task", listRestarted.tasks?.some((t) => t.id === taskId), true);
} finally {
  await stopApp(app2);
}

finish();
