// Per-card identity (design 277cb882): forged LIVE card ids are refused;
// ?card= TCP stamps are refused; authenticated caller cannot assert another
// card's id via body callerCardId.
// Isolated instance only.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_TOKEN = `verify-peer-ident-${CDP_PORT}`;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-peer-card-identity-${CDP_PORT}`, import.meta.url).pathname;

let nextRpcId = 1;
async function toolJson(name, args, callerCardId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${MCP_TOKEN}`,
  };
  if (callerCardId) headers["x-stellar-caller-card"] = callerCardId;
  const res = await fetch(MCP_BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  const rpc = JSON.parse(jsonLine);
  if (rpc.error) return { ok: false, error: JSON.stringify(rpc.error), httpStatus: res.status };
  try {
    return JSON.parse(rpc.result.content[0].text);
  } catch {
    return { ok: false, error: text, httpStatus: res.status };
  }
}

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_MCP_INTERNAL_TOKEN: MCP_TOKEN },
});

try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 800));
  await bootIntoFreshSession(page, "Peer Identity", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 1000));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const terminals = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === "terminal").map((c) => ({ id: c.id, provider: c.provider }))))`,
    ),
  );
  check("at least one live terminal card", terminals.length >= 1, true);
  const cardA = terminals[0]?.id;
  check("card A id is a string", typeof cardA, "string");

  // TCP ?card= refused even for a LIVE card id
  const stamped = await fetch(`${MCP_BASE}?card=${encodeURIComponent(cardA)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  check("TCP ?card= refused for live card id", stamped.status, 400);
  const stampedBody = await stamped.json();
  check("refusal names ?card", String(stampedBody.error ?? "").includes("?card"), true);

  // Header without Bearer refused
  const noBearer = await fetch(MCP_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-stellar-caller-card": cardA,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("caller header without Bearer refused", noBearer.status, 401);

  // Card A can report as itself
  const asA = await toolJson("report", { report: { ok: true, who: "a", evidence: "self" } }, cardA);
  check("card A reports as itself", asA.ok === true, true);

  // Authenticated as A cannot assert a different live-looking id in the body
  const otherLiveLooking = `${cardA}-forged`;
  const forgedBody = await toolJson(
    "report",
    { report: { ok: true, who: "forged" }, callerCardId: otherLiveLooking },
    cardA,
  );
  check("authenticated A cannot pass a different callerCardId", forgedBody.ok === false, true);
  check(
    "refusal names callerCardId",
    String(forgedBody.error ?? "").toLowerCase().includes("callercardid"),
    true,
  );

  // Unknown caller card header refused
  const ghost = await fetch(MCP_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${MCP_TOKEN}`,
      "x-stellar-caller-card": "not-a-live-card-id",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  check("unknown caller card header refused", ghost.status, 401);

  // Second card: upsert into the store FIRST, then pty.spawn with the real
  // (id, provider, cwd, cols, rows) signature. Spawning without upsert (or
  // with opts-as-cwd) was the intermittent "second terminal without
  // process-identity" gap — register ran with no board row / failed spawn.
  let cardB = terminals[1]?.id;
  if (!cardB) {
    const spawned = JSON.parse(
      await page.evalJs(`
        (async () => {
          const boards = await window.store.boards.list();
          const boardId = boards[0]?.id;
          if (!boardId) return JSON.stringify({ error: "no board" });
          const id = "peer-b-" + Date.now().toString(36);
          const cwd = ${JSON.stringify(process.cwd())};
          await window.store.upsert({
            id,
            board_id: boardId,
            kind: "terminal",
            provider: "bash",
            cwd,
            x: 40,
            y: 40,
            w: 640,
            h: 400,
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
          const result = await window.pty.spawn(id, "bash", cwd, 80, 24, {});
          return JSON.stringify(result);
        })()
      `),
    );
    cardB = spawned?.id ?? null;
    if (cardB) await new Promise((r) => setTimeout(r, 800));
  }

  if (cardB && cardB !== cardA) {
    const asB = await toolJson("report", { report: { ok: true, who: "b", evidence: "self-b" } }, cardB);
    check("card B reports as itself", asB.ok === true, true);
    const aAsB = await toolJson(
      "report",
      { report: { ok: true, who: "a-as-b" }, callerCardId: cardB },
      cardA,
    );
    check("A cannot claim B via callerCardId body", aAsB.ok === false, true);
  } else {
    check("second terminal card spawned", false, true);
  }

  finish();
} finally {
  await stopApp(app);
}
