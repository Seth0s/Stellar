// browser_run — one MCP call, several actions on a live browser card.
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_URL = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-run-${CDP_PORT}`);

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  let result;
  try {
    result = await callTool(name, args);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  const body = result.content[0].text;
  try {
    return JSON.parse(body);
  } catch {
    return { ok: false, error: body };
  }
}
function parseEval(raw) {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body>
  <input id="email" type="text" />
  <button id="go" onclick="document.getElementById('out').textContent='done:'+document.getElementById('email').value">Go</button>
  <div id="out">idle</div>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser run", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  async function waitFor(selector, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`)) === true) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`selector ${selector} never appeared within ${timeoutMs}ms`);
  }
  await waitFor('[data-role="rail-add-card"]');
  const railBtn = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('[data-role="rail-add-card"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(railBtn.x, railBtn.y);
  await waitFor('.popover-row[data-kind="browser"]');
  const browserRow = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('.popover-row[data-kind="browser"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(browserRow.x, browserRow.y);
  await new Promise((r) => setTimeout(r, 1000));
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardIds = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))`,
    ),
  );
  const cardId = cardIds[cardIds.length - 1];
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(`http://127.0.0.1:${port}/`)})`);
  await new Promise((r) => setTimeout(r, 1200));

  // Refuse empty / over-limit before anything runs
  const empty = await toolJson("browser_run", { target: cardId, steps: [] });
  check("empty steps is refused", empty.ok, false);
  check("...and names steps", /steps/i.test(empty.error ?? ""), true);

  // Happy path: type → click → wait_for → eval in ONE call
  const run = await toolJson("browser_run", {
    target: cardId,
    finalSnapshot: true,
    steps: [
      { action: "type", selector: "#email", text: "ada@lovelace.test" },
      { action: "click", selector: "#go" },
      { action: "wait_for", text: "done:ada@lovelace.test", timeoutMs: 5000 },
      { action: "eval", js: "return document.getElementById('out').textContent" },
    ],
  });
  check("browser_run ok for a 4-step screen flow", run.ok, true);
  check("...returns one outcome per step", Array.isArray(run.steps) && run.steps.length === 4, true);
  check("...every step ok", run.steps?.every((s) => s.ok) === true, true);
  check("...eval step yields the post-click text", parseEval(run.steps?.[3]?.result?.result), "done:ada@lovelace.test");
  check("...each step carries after.url", run.steps?.every((s) => typeof s.after?.url === "string") === true, true);
  check("...finalSnapshot present when requested", run.finalSnapshot?.ok === true, true);

  // Live page really changed (owner-visible card, not just the tool reply)
  const live = parseEval(
    (await toolJson("browser_eval", { target: cardId, js: "return document.getElementById('out').textContent" })).result,
  );
  check("page DOM matches the batch (live card)", live, "done:ada@lovelace.test");

  // stopOnError: true stops after a bad click
  const stopped = await toolJson("browser_run", {
    target: cardId,
    stopOnError: true,
    steps: [
      { action: "click", selector: "#missing-nope" },
      { action: "eval", js: "return 'should-not-run'" },
    ],
  });
  check("stopOnError stops the run", stopped.ok, false);
  check("...only the failing step ran", stopped.steps?.length === 1, true);
  check("...stoppedEarly is true", stopped.stoppedEarly === true, true);

  finish();
} catch (err) {
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:\n${app.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  server.close();
}
