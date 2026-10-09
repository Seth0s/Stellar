import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-scope-${CDP_PORT}`);
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ACBRIDGE = join(PROJECT_ROOT, "resources/bin/acbridge");
let nextRpcId = 1;

async function mcpCall(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const body = await response.text();
  const jsonLine = body.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? body;
  return JSON.parse(jsonLine);
}

async function callTool(name, args, url = MCP_URL) {
  const rpc = await mcpCall(url, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP ${name} failed: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}

function runAcbridge(env, ...args) {
  return spawnSync(process.execPath, [ACBRIDGE, ...args], { encoding: "utf8", env });
}

function findSocketPath(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findSocketPath(path);
      if (nested) return nested;
    } else if (entry.name === "agent-canvas.sock" && statSync(path).isSocket()) {
      return path;
    }
  }
  return null;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await bootIntoFreshSession(page, "Board Scope", { spawnTerminal: true });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const seeded = JSON.parse(await page.evalJs(`(async () => {
    const boards = await window.store.boards.list();
    const boardA = boards[0];
    const cardsA = await window.store.list(boardA.id);
    const terminalA = cardsA.find((card) => card.kind === "terminal");
    const boardB = {
      ...boardA,
      id: "board-scope-b",
      name: "Board Scope B",
      created_at: Date.now(),
      updated_at: Date.now(),
      last_accessed_at: Date.now(),
      orchestrator_card_id: null,
      autonomous: false,
      concurrency_cap: null,
    };
    await window.store.boards.upsert(boardB);
    await window.store.upsert({
      id: "board-scope-b-sticky",
      board_id: boardB.id,
      kind: "sticky",
      provider: "",
      cwd: "secret board B content",
      x: 30,
      y: 30,
      w: 320,
      h: 180,
      resume_id: null,
      model: null,
      effort: null,
      system_prompt: null,
      group_id: null,
      label: null,
      updated_at: Date.now(),
      messages_json: null,
      archived_at: null,
    });
    return JSON.stringify({ boardAId: boardA.id, boardBId: boardB.id, cardAId: terminalA?.id, cardBId: "board-scope-b-sticky" });
  })()`));

  check("an authenticated card exists on board A", typeof seeded.cardAId, "string");
  check("board B has a separate sticky resource", seeded.boardBId !== seeded.boardAId, true);

  const cardUrl = `${MCP_URL}?card=${encodeURIComponent(seeded.cardAId)}`;
  const listed = JSON.parse((await callTool("list_cards", {}, cardUrl)).content[0].text);
  check("MCP list_cards includes the caller board's terminal", listed.cards.some((card) => card.id === seeded.cardAId), true);
  check("MCP list_cards hides the other board's sticky", listed.cards.some((card) => card.id === seeded.cardBId), false);

  const foreignSticky = JSON.parse((await callTool("read_sticky", { target: seeded.cardBId }, cardUrl)).content[0].text);
  check("MCP read_sticky refuses a foreign target and names target", foreignSticky.ok, false);
  check("MCP foreign-target refusal identifies the field", foreignSticky.error, (error) => String(error).includes("target"));

  const profileId = readdirSync(join(USER_DATA_DIR, "profiles"), { withFileTypes: true }).find((entry) => entry.isDirectory())?.name;
  if (!profileId) throw new Error("isolated profile directory was not created");
  const socketPath = findSocketPath(USER_DATA_DIR);
  check("the acbridge socket exists inside the isolated userData tree", {
    socketPath,
    startupOutput: socketPath ? undefined : app.stderr(),
  }, (evidence) => typeof evidence.socketPath === "string");
  const childEnv = {
    ...process.env,
    AGENT_CANVAS_SOCK: socketPath ?? join(USER_DATA_DIR, "profiles", profileId, "agent-canvas.sock"),
    AGENT_CANVAS_CARD_ID: seeded.cardAId,
    AGENT_CANVAS_TASK_ID: "",
  };
  const bridgeList = runAcbridge(childEnv, "list");
  check("acbridge list succeeds from the authenticated card", {
    status: bridgeList.status,
    stdout: bridgeList.stdout,
    stderr: bridgeList.stderr,
  }, (result) => result.status === 0);
  check("acbridge list does not expose board B's sticky", bridgeList.stdout.includes(seeded.cardBId), false);

  const bridgeRead = runAcbridge(childEnv, "read-sticky", seeded.cardBId);
  check("acbridge read-sticky refuses a foreign target", bridgeRead.status, 1);
  check("acbridge foreign-target refusal identifies target", `${bridgeRead.stderr}${bridgeRead.stdout}`, (output) => output.includes("target"));

  page.close();
} finally {
  await stopApp(app);
}
finish();
