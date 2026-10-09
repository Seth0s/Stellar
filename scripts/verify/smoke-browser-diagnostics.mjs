// Diagnostics on timeout + richer snapshot + scoped page text + SPA notFound.
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_URL = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-diag-${CDP_PORT}`);

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
  try {
    const result = await callTool(name, args);
    return JSON.parse(result.content[0].text);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Diag home</title></head>
<body>
  <h1>Home heading</h1>
  <p id="chip">Status chip visible</p>
  <button id="open" onclick="document.getElementById('dlg').showModal()">Open dialog</button>
  <dialog id="dlg"><p>Modal only text</p><button id="close" onclick="this.closest('dialog').close()">Close</button></dialog>
  <button id="below" style="position:absolute;top:8000px;left:8px">Below fold</button>
  <script>
    history.replaceState({}, "", "/home");
    window.addEventListener("popstate", () => {
      if (location.pathname === "/missing") {
        document.title = "404 — Not Found";
        document.body.innerHTML = "<h1>404</h1><p>Page not found</p>";
      } else if (location.pathname === "/ok") {
        document.title = "OK page";
        document.body.innerHTML = "<h1>All good</h1>";
      }
    });
  </script>
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
  await bootIntoFreshSession(page, "Browser diag", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  async function waitFor(selector, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await page.evalJs(`!!document.querySelector(${JSON.stringify(selector)})`)) === true) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`selector ${selector} never appeared`);
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

  // (1) wait_for timeout carries context
  const waited = await toolJson("browser_wait_for", {
    target: cardId,
    text: "NEVER-APPEARS-XYZ",
    timeoutMs: 800,
  });
  check("wait_for timeout is refused", waited.ok, false);
  check("...carries context.url", typeof waited.context?.url === "string", true);
  check("...carries visibleText", typeof waited.context?.visibleText === "string" && waited.context.visibleText.length > 0, true);
  check("...visibleText mentions Home", /Home/i.test(waited.context?.visibleText ?? ""), true);

  // (2) navigate to SPA soft-404 → notFound
  const nav404 = await toolJson("browser_navigate", {
    target: cardId,
    url: "/missing",
    timeoutMs: 5000,
  });
  check("navigate to soft-404 still settles", nav404.ok === true || nav404.notFound === true, true);
  check("...signals notFound", nav404.notFound === true, true);
  check("...names a reason", typeof nav404.notFoundReason === "string" && nav404.notFoundReason.length > 0, true);

  // Reset to a healthy route for snapshot/text tests
  await toolJson("browser_navigate", { target: cardId, url: "/ok", timeoutMs: 5000 });
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(`http://127.0.0.1:${port}/`)})`);
  await new Promise((r) => setTimeout(r, 1000));

  // (3) snapshot includeText + includeBoxes + offscreen
  const snap = await toolJson("browser_snapshot", {
    target: cardId,
    includeText: true,
    includeBoxes: true,
  });
  check("snapshot ok", snap.ok, true);
  check("...elements have offscreen boolean", snap.elements?.every((e) => typeof e.offscreen === "boolean") === true, true);
  check("...includeBoxes adds box", snap.elements?.some((e) => e.box && typeof e.box.w === "number") === true, true);
  check("...includeText lists chip text", snap.elements?.some((e) => /Status chip/i.test(e.name || e.text || "")) === true, true);
  check("...below-fold button marked offscreen", snap.elements?.some((e) => e.name === "Below fold" && e.offscreen === true) === true, true);

  // Open dialog and scope get_page_text / snapshot to it by default
  await toolJson("browser_click", { target: cardId, selector: "#open" });
  await new Promise((r) => setTimeout(r, 300));
  const modalText = await toolJson("get_page_text", { target: cardId });
  check("get_page_text defaults to open dialog", modalText.ok, true);
  check("...contains modal text", /Modal only text/i.test(modalText.text ?? ""), true);
  check("...does not pull Home heading behind", !/Home heading/i.test(modalText.text ?? ""), true);
  check("...scopeSource is dialog", modalText.scopeSource === "dialog", true);

  const modalSnap = await toolJson("browser_snapshot", { target: cardId });
  check("snapshot defaults to dialog scope", modalSnap.scopeSource === "dialog", true);

  finish();
} catch (err) {
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:\n${app.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  server.close();
}
