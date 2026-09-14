// Live proof: session id on task_cards survives card DELETE, and
// get_task → spawn_agent({ resumeId }) can reopen THAT session.
// Isolated instance only — never the owner's userData.
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
  spawnCard,
} from "./cdp-client.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-session-survives-card-${CDP_PORT}`, import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function toolJson(url, name, args) {
  const rpc = await mcpCall(url, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

async function clickModalButton(page, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    if (coords) {
      await page.click(coords.x, coords.y);
      return true;
    }
    await delay(80);
  }
  return false;
}

const { check, finish } = makeChecker();
process.env.VERIFY_KEEP_USERDATA = "1";
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Session Survives Card", { spawnTerminal: true });
  await delay(400);

  await spawnCard(page, "task");
  check("Fila monta", await page.evalJs(`!!document.querySelector('[data-part="create-task-input"]')`), true);

  const boardId = await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "Session Survives Card") ?? boards[0];
      return board.id;
    })()
  `);

  // claude (like the other MCP smokes) — imposes session id at spawn,
  // same Camada-2 stamp path as cursor (IMPOSE_SESSION_ID_PROVIDERS).
  const created = await toolJson(MCP_URL, "create_task", {
    prompt: "prova: sessão sobrevive ao DELETE do card",
    provider: "claude",
    boardId,
  });
  check("create_task ok", created.ok, true);
  const taskId = created.taskId;

  const cards = await toolJson(MCP_URL, "list_cards", {});
  const requesterId = cards.cards.find((c) => c.kind === "terminal")?.id;
  check("tem requester terminal", typeof requesterId, "string");

  // Human-in-the-loop on purpose (same as smoke-fila-liveness): approve
  // via real AgentAskModal — do not depend on autonomous for this proof.
  const spawnPromise = toolJson(MCP_URL, "spawn_agent", {
    provider: "claude",
    callerCardId: requesterId,
    taskId,
    reason: "prova ao vivo: gravar session_id na participação",
    label: "session-survive-1",
  });
  check("modal de spawn / Allow", await clickModalButton(page, "Permitir"), true);
  const spawned = await spawnPromise;
  if (!spawned.ok) {
    console.error("spawn_agent failed:", JSON.stringify(spawned));
  }
  check("spawn_agent ok", spawned.ok, true);
  const childId = spawned.cardId;

  let sessionId = null;
  let requestedResumeId = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const got = await toolJson(MCP_URL, "get_task", { taskId });
    const link = got.task?.cards?.find((c) => c.cardId === childId);
    if (link?.sessionId) {
      sessionId = link.sessionId;
      requestedResumeId = link.requestedResumeId ?? null;
      break;
    }
    await delay(100);
  }
  check("get_task.cards[].sessionId gravado com card vivo", typeof sessionId, "string");
  check("fresh spawn: requestedResumeId é null (não inventar)", requestedResumeId, null);

  const closePromise = toolJson(MCP_URL, "close_card", {
    target: childId,
    callerCardId: requesterId,
    reason: "prova: matar o card e ver se a sessão ficou na task",
  });
  check("modal de close / Allow", await clickModalButton(page, "Permitir"), true);
  const closed = await closePromise;
  check("close_card ok", closed.ok, true);
  await delay(400);

  const afterClose = await toolJson(MCP_URL, "get_task", { taskId });
  const linkAfter = afterClose.task?.cards?.find((c) => c.cardId === childId);
  check("após DELETE, get_task ainda devolve sessionId", linkAfter?.sessionId, sessionId);

  const dbPath = join(USER_DATA_DIR, "agent-canvas.db");
  const db = new Database(dbPath, { readonly: true });
  const cardRow = db.prepare("SELECT id FROM cards WHERE id = ?").get(childId);
  const tcRow = db
    .prepare("SELECT session_id, requested_resume_id FROM task_cards WHERE task_id = ? AND card_id = ?")
    .get(taskId, childId);
  db.close();
  check("linha de cards foi apagada", cardRow, undefined);
  check("task_cards.session_id sobreviveu ao DELETE", tcRow?.session_id, sessionId);

  const resumePromise = toolJson(MCP_URL, "spawn_agent", {
    provider: "claude",
    callerCardId: requesterId,
    taskId,
    resumeId: linkAfter.sessionId,
    reason: "prova ao vivo: retomar a sessão que a task guardou",
    label: "session-survive-resume",
  });
  check("modal de resume / Allow", await clickModalButton(page, "Permitir"), true);
  const resumed = await resumePromise;
  if (!resumed.ok) {
    console.error("resume spawn failed:", JSON.stringify(resumed));
  }
  check("spawn_agent resume ok", resumed.ok, true);

  const afterResume = await toolJson(MCP_URL, "get_task", { taskId });
  const resumeLink = afterResume.task?.cards?.find((c) => c.cardId === resumed.cardId);
  check(
    "nova participação gravou requestedResumeId = sessão anterior",
    resumeLink?.requestedResumeId,
    sessionId,
  );

  const listed = await toolJson(MCP_URL, "list_tasks", { boardId, view: "summary" });
  const lean = listed.tasks?.find((t) => t.id === taskId);
  check("list_tasks não traz cards[]", lean?.cards, undefined);
} finally {
  await stopApp(app);
}

finish();
