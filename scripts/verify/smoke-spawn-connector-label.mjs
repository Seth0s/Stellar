// Live proof: spawn_agent with task.purpose → connector.label from
// deriveAutoConnectLabel (ONE source), never from reason.
// Human-approve modal path. MCP URL stamped with ?card= (callerCardId
// in the body is NOT trusted without the URL stamp — caller-identity.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-spawn-connector-label-${CDP_PORT}`, import.meta.url).pathname;
mkdirSync(USER_DATA_DIR, { recursive: true });

let nextRpcId = 1;
async function mcpCall(mcpUrl, method, params) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function callTool(mcpUrl, name, args) {
  const rpc = await mcpCall(mcpUrl, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(mcpUrl, name, args) {
  const result = await callTool(mcpUrl, name, args);
  return JSON.parse(result.content[0].text);
}
async function clickModalButton(page, label) {
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
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Spawn Connector Label");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson(MCP_BASE, "list_cards", {});
  const bashId = listPayload.cards.find((c) => c.kind === "terminal").id;
  check("terminal seed", typeof bashId === "string", true);
  const asBash = `${MCP_BASE}?card=${encodeURIComponent(bashId)}`;

  const created = await toolJson(asBash, "create_task", {
    prompt: "prova ao vivo do label do connector de spawn",
    provider: "bash",
    purpose: "fix",
  });
  check("create_task ok", created.ok === true && typeof created.taskId === "string", true);

  const reasonTrap = "REGRAS DESTE BOARD — se isto virar label, a fonte ainda é reason";
  const spawnPromise = callTool(asBash, "spawn_agent", {
    provider: "bash",
    taskId: created.taskId,
    label: "prova-connector-label",
    reason: reasonTrap,
  });
  await new Promise((r) => setTimeout(r, 600));
  await clickModalButton(page, "Permitir");
  const spawned = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent ok", spawned.ok === true && typeof spawned.cardId === "string", true);
  await new Promise((r) => setTimeout(r, 500));

  const dbPath = join(USER_DATA_DIR, "agent-canvas.db");
  const db = new Database(dbPath);
  db.pragma("wal_checkpoint(TRUNCATE)");
  const row = db
    .prepare(
      `SELECT id, from_card_id, to_card_id, kind, label FROM connectors
       WHERE kind = 'spawned' AND to_card_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(spawned.cardId);
  db.close();

  console.log("SQLITE connector row:", JSON.stringify(row));
  check("connector spawned existe", !!row, true);
  check("label é purpose (correção), NÃO o reason", row?.label, "correção");
  check("reason-trap ausente do label", !String(row?.label || "").includes("REGRAS"), true);
  check("from = requester", row?.from_card_id, bashId);
  check("to = spawned card", row?.to_card_id, spawned.cardId);
} finally {
  await stopApp(app);
}
finish();
