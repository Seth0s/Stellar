import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-agent-notices-${CDP_PORT}`, import.meta.url).pathname;
const SPAWN_CWD = fileURLToPath(new URL("../..", import.meta.url));
const GATE_DETAIL = `NOTICE-GATE-DETAIL-${CDP_PORT}`;
let mcpUrl = MCP_BASE;
let nextRpcId = 1;

async function mcpCall(method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const body = await response.text();
  const jsonLine = body.startsWith("event:") ? body.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() : body;
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
        const button = [...document.querySelectorAll('.modal-actions button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
        if (!button) return JSON.stringify(null);
        const rect = button.getBoundingClientRect();
        return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Agent Notice Gate Contradiction");
  await delay(500);

  const requesterId = JSON.parse(
    await page.evalJs(
      `JSON.stringify(document.querySelector('[data-card-id]')?.getAttribute('data-card-id') ?? null)`,
    ),
  );
  if (!requesterId) throw new Error("fresh session has no rendered terminal card to authenticate MCP requests");
  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(requesterId)}`;

  const initialCards = await toolJson("list_cards", {});
  const shellId = Array.isArray(initialCards.cards)
    ? initialCards.cards.find((card) => card.kind === "terminal" && card.provider === "bash")?.id
    : undefined;
  if (!shellId) throw new Error(`isolated board has no bash requester card: ${JSON.stringify(initialCards)}`);
  check("isolated session has a bash requester card", typeof shellId, "string");

  const claudeSpawn = callTool("spawn_agent", {
    provider: "claude",
    cwd: SPAWN_CWD,
    callerCardId: shellId,
    reason: "receive a one-line gate contradiction notice",
    label: "notice-orchestrator",
  });
  await delay(500);
  await clickModalButton(page, "Permitir");
  const claudeResult = JSON.parse((await claudeSpawn).content[0].text);
  check("Claude card was created in the isolated app", claudeResult.ok && typeof claudeResult.cardId === "string", true);
  const claudeId = claudeResult.cardId;
  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(claudeId)}`;

  const workerSpawn = callTool("spawn_agent", {
    provider: "bash",
    cwd: SPAWN_CWD,
    callerCardId: claudeId,
    reason: "produce a gate result for the notice smoke",
  });
  await delay(500);
  await clickModalButton(page, "Permitir");
  const workerResult = JSON.parse((await workerSpawn).content[0].text);
  check("child worker card was created", workerResult.ok && typeof workerResult.cardId === "string", true);
  const workerId = workerResult.cardId;

  const created = await toolJson("create_task", {
    prompt: "Smoke task for one-line gate contradiction notices.",
    provider: "bash",
    cardId: workerId,
    cwd: SPAWN_CWD,
    gates: [`node -e ${JSON.stringify(`process.stdout.write('${GATE_DETAIL}');process.exit(1)`)}`],
  });
  check("gate task was created and linked to the worker", created.ok && typeof created.taskId === "string", true);

  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(workerId)}`;
  const report = JSON.parse(
    (await callTool("report", { report: { ok: true, taskId: created.taskId, result: "gate contradiction smoke" } })).content[0].text,
  );
  check("worker report was accepted", report.ok, true);

  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(claudeId)}`;
  let screen = "";
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await delay(500);
    const read = await toolJson("read_card", { target: claudeId });
    screen = read.text ?? "";
    if (screen.includes("gate contradiction")) break;
  }
  check("Claude card received the contradiction pointer", screen.includes("gate contradiction"), true);
  check("Claude received the get_task detail pointer", screen.includes("get_task"), true);
  check("gate command output was not pasted into Claude", !screen.includes(GATE_DETAIL), true);
  check("multiline gate output header was not pasted into Claude", !screen.includes("Last output:"), true);

  const stored = await toolJson("get_task", { taskId: created.taskId });
  check("full gate evidence remains available on the task", JSON.stringify(stored).includes(GATE_DETAIL), true);
  page.close();
} finally {
  await stopApp(app);
}
finish();
