// Task fcea2274 — browser_route / browser_unroute: intercept fetch inside
// one browser card, show a badge, clear on unroute. Born RED before the
// tools existed (Unrecognized key / unknown cmd).
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
let mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-route-${CDP_PORT}`);

let nextRpcId = 1;
async function toolJson(name, args) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  const rpc = JSON.parse(jsonLine);
  if (rpc.error) return { ok: false, error: JSON.stringify(rpc.error) };
  try {
    return JSON.parse(rpc.result.content[0].text);
  } catch {
    return { ok: false, error: rpc.result?.content?.[0]?.text };
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

const FIXTURE = `<!doctype html><html><body>
<h1>route fixture</h1>
<pre id="out">idle</pre>
<script>
  window.__hits = 0;
  window.runFetch = async () => {
    window.__hits++;
    try {
      const r = await fetch('/api/items');
      const t = await r.text();
      document.getElementById('out').textContent = r.status + ':' + t;
      return { status: r.status, body: t };
    } catch (err) {
      document.getElementById('out').textContent = 'ERR:' + String(err);
      return { error: String(err) };
    }
  };
</script>
</body></html>`;

let realHits = 0;
const server = createServer((req, res) => {
  if (req.url === "/api/items") {
    realHits++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ source: "real", n: realHits }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, finish } = makeChecker();
const appHandle = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 800));
  await bootIntoFreshSession(page, "Browser route", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 800));

  async function waitFor(selector, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`)) === true) return;
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`selector ${selector} never appeared`);
  }
  await waitFor('[data-role="rail-add-card"]');
  const rail = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('[data-role="rail-add-card"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(rail.x, rail.y);
  await waitFor('.popover-row[data-kind="browser"]');
  const brow = JSON.parse(
    await page.evalJs(`(() => {
      const b = document.querySelector('.popover-row[data-kind="browser"]');
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`),
  );
  await page.click(brow.x, brow.y);
  await new Promise((r) => setTimeout(r, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const listed = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.map((c) => ({ id: c.id, kind: c.kind }))))`,
    ),
  );
  const caller = listed.find((c) => c.kind === "terminal");
  const cardId = listed.filter((c) => c.kind === "browser").at(-1)?.id;
  if (!caller || !cardId) throw new Error(`cards missing: ${JSON.stringify(listed)}`);
  mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp?card=${encodeURIComponent(caller.id)}`;

  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(`http://127.0.0.1:${port}/`)})`);
  await new Promise((r) => setTimeout(r, 1200));

  async function evalOn(js) {
    return parseEval((await toolJson("browser_eval", { target: cardId, js })).result);
  }

  // Real network first
  const beforeRoute = await evalOn(`window.runFetch()`);
  check("real fetch returns 200 before mock", beforeRoute?.status, 200);
  check("real server was hit once", realHits, 1);

  const routed = await toolJson("browser_route", {
    target: cardId,
    urlPattern: "*/api/items",
    method: "GET",
    response: { status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "mock", empty: true }) },
  });
  check("browser_route accepted", routed.ok, true);
  check("browser_route returns route id", typeof routed.route?.id === "string", true);

  const listedRoutes = await toolJson("browser_list_routes", { target: cardId });
  check("list_routes shows the mock", listedRoutes.ok && listedRoutes.routes?.length === 1, true);

  // Badge visible on the card (owner-facing)
  await new Promise((r) => setTimeout(r, 300));
  const badgeVisible = await page.evalJs(`!!document.querySelector('[data-role="browser-routes-badge"]')`);
  check("routes badge is visible on the board", badgeVisible === true, true);

  const mocked = await evalOn(`window.runFetch()`);
  check("mocked fetch returns 503", mocked?.status, 503);
  check("mocked body is the stub", mocked?.body, JSON.stringify({ source: "mock", empty: true }));
  check("real server was NOT hit again", realHits, 1);

  const cleared = await toolJson("browser_unroute", { target: cardId });
  check("browser_unroute clears all", cleared.ok && (cleared.routes?.length ?? 0) === 0, true);

  const after = await evalOn(`window.runFetch()`);
  check("after unroute, real network resumes", after?.status, 200);
  check("real server hit again after unroute", realHits, 2);

  finish();
} catch (err) {
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:\n${appHandle.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(appHandle);
  server.close();
}
