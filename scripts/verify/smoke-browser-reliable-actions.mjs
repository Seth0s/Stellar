// Task 172da48e — reliable browser actions: role/text targeting, empty
// replace:true, CDP pointer sequence on a Radix-like widget, iframe frame=,
// and post-action state / unchanged warning.
//
// Born RED against the prior build (replace refused empty fields; no role/
// text; sendInputEvent alone; no frame; no after state).
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
// Board-scoped MCP: anonymous `/mcp` is refused. Stamp the caller's card on
// the URL the same way a real agent process gets `/mcp?card=<id>`.
let mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-reliable-actions-${CDP_PORT}`);

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(mcpUrl, {
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
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
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

// Minimal Radix-like tabs: activate on pointerdown (not click alone).
// Plus getByRole/getByText targets, empty field, iframe, no-op button.
const INNER = `<!doctype html><html><body>
  <button id="inner-btn" type="button">Dentro do iframe</button>
  <script>document.getElementById('inner-btn').onclick=()=>{document.title='iframe-ok'};</script>
</body></html>`;

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  /* Panels hide; tab TRIGGERS stay visible (Radix keeps triggers in the tree). */
  .panel[data-state=inactive]{display:none}
  .tab{padding:8px 12px;margin:4px;border:1px solid #888;cursor:pointer}
  .tab[data-state=active]{background:#222;color:#fff}
</style></head><body>
<h1>Reliable actions fixture</h1>
<div role="tablist">
  <button type="button" role="tab" class="tab" id="tab-a" data-state="active" aria-selected="true">Agenda</button>
  <button type="button" role="tab" class="tab" id="tab-b" data-state="inactive" aria-selected="false">Novo evento</button>
</div>
<div id="panel-a" class="panel" data-state="active">Painel agenda</div>
<div id="panel-b" class="panel" data-state="inactive">Painel novo</div>
<button type="button" id="plain-btn">Salvar rascunho</button>
<input id="empty-field" value="" placeholder="vazio" />
<input id="noop-field" value="10:00" readonly />
<button type="button" id="noop-btn" aria-expanded="false">Horario</button>
<iframe id="kid" src="/inner" style="width:320px;height:120px;border:1px solid #ccc"></iframe>
<script>
  window.__ptr = [];
  function logPtr(e) {
    window.__ptr.push({ type: e.type, id: e.target && e.target.id, isTrusted: e.isTrusted });
  }
  for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
    document.addEventListener(t, logPtr, true);
  }
  // Radix-style: switch tabs on pointerdown (NOT on click alone).
  function activate(tab) {
    for (const el of document.querySelectorAll('[role=tab]')) {
      const on = el === tab;
      el.dataset.state = on ? 'active' : 'inactive';
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    document.getElementById('panel-a').dataset.state = tab.id === 'tab-a' ? 'active' : 'inactive';
    document.getElementById('panel-b').dataset.state = tab.id === 'tab-b' ? 'active' : 'inactive';
  }
  for (const tab of document.querySelectorAll('[role=tab]')) {
    tab.addEventListener('pointerdown', (e) => { activate(e.currentTarget); });
  }
  document.getElementById('noop-btn').addEventListener('click', () => {
    /* intentionally no state change — measures the unchanged warning */
  });
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/inner") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INNER);
    return;
  }
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
  await bootIntoFreshSession(page, "Reliable actions", { spawnTerminal: true });
  await new Promise((r) => setTimeout(r, 1000));

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
  const listed = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.map((c) => ({ id: c.id, kind: c.kind }))))`,
    ),
  );
  const callerCard = listed.find((c) => c.kind === "terminal") ?? listed[0];
  const cardId = listed.filter((c) => c.kind === "browser").at(-1)?.id;
  if (!cardId || !callerCard) throw new Error(`missing cards: ${JSON.stringify(listed)}`);
  mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp?card=${encodeURIComponent(callerCard.id)}`;
  await page.evalJs(`window.browser.navigate(${JSON.stringify(cardId)}, ${JSON.stringify(`http://127.0.0.1:${port}/`)} )`);

  async function evalOn(js) {
    return parseEval((await toolJson("browser_eval", { target: cardId, js })).result);
  }
  const readyDeadline = Date.now() + 15000;
  while (Date.now() < readyDeadline) {
    const ok = await evalOn(`!!document.getElementById('tab-b')`);
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // --- 1. role + name (getByRole) activates Radix-like tab via pointerdown ---
  await evalOn(`window.__ptr = []; 'ok'`);
  const byRole = await toolJson("browser_click", {
    target: cardId,
    role: "tab",
    name: "Novo evento",
  });
  check("click by role+name is ok", byRole.ok, true);
  check("click by role+name returns after state", byRole.after != null, true);
  const tabBActive = await evalOn(`document.getElementById('tab-b').dataset.state`);
  check("Radix-like tab activates on pointer sequence", tabBActive, "active");
  const ptr = await evalOn(`JSON.stringify(window.__ptr.map(e => e.type))`);
  const ptrList = Array.isArray(ptr) ? ptr : typeof ptr === "string" ? JSON.parse(ptr) : [];
  check("pointerdown appears in the trusted sequence", ptrList.includes("pointerdown"), true);
  check("mousedown appears in the trusted sequence", ptrList.includes("mousedown"), true);

  // --- 2. getByText ---
  await evalOn(`document.getElementById('plain-btn').dataset.hit = ''; 'ok'`);
  await evalOn(`document.getElementById('plain-btn').onclick = () => { document.getElementById('plain-btn').dataset.hit = '1'; }; 'ok'`);
  const byText = await toolJson("browser_click", { target: cardId, text: "Salvar rascunho" });
  check("click by text is ok", byText.ok, true);
  check("click by text hit the button", String(await evalOn(`document.getElementById('plain-btn').dataset.hit`)), "1");

  // --- 3. replace:true on EMPTY field just types ---
  const emptyReplace = await toolJson("browser_type", {
    target: cardId,
    selector: "#empty-field",
    text: "preenchido",
    replace: true,
  });
  check("replace:true on empty field is accepted", emptyReplace.ok, true);
  check("empty replace wrote the value", await evalOn(`document.getElementById('empty-field').value`), "preenchido");
  check("type returns after.value", emptyReplace.after?.value, "preenchido");

  // --- 4. frame= iframe ---
  const frameSnap = await toolJson("browser_snapshot", { target: cardId, frame: "#kid" });
  check("snapshot inside iframe is ok", frameSnap.ok, true);
  check(
    "iframe snapshot lists the inner button",
    Array.isArray(frameSnap.elements) &&
      frameSnap.elements.some((e) => /Dentro do iframe|inner-btn|button/i.test(`${e.name || ""} ${e.tag || ""}`)),
    true,
  );
  const frameClick = await toolJson("browser_click", {
    target: cardId,
    text: "Dentro do iframe",
    frame: "#kid",
  });
  check("click inside iframe is ok", frameClick.ok, true);
  const iframeTitle = await evalOn(`document.getElementById('kid').contentDocument.title`);
  check("iframe click had effect", iframeTitle, "iframe-ok");

  // --- 5. unchanged warning ---
  const noop = await toolJson("browser_click", { target: cardId, selector: "#noop-btn" });
  check("no-op click still ok", noop.ok, true);
  check(
    "no-op click warns that state did not change",
    typeof noop.warning === "string" && /did not change/i.test(noop.warning),
    true,
  );

  // --- 6. stable ref rebound after stamp wipe ---
  const snap = await toolJson("browser_snapshot", { target: cardId });
  check("snapshot ok", snap.ok, true);
  const save = (snap.elements || []).find((e) => /Salvar rascunho/i.test(e.name || ""));
  check("snapshot has Salvar rascunho", !!save, true);
  await evalOn(`document.querySelectorAll('[data-stellar-ref]').forEach(el => el.removeAttribute('data-stellar-ref')); 'ok'`);
  await evalOn(`document.getElementById('plain-btn').dataset.hit = ''; 'ok'`);
  const rebound = await toolJson("browser_click", { target: cardId, ref: save.ref });
  check("dead ref rebounds via role+name handle", rebound.ok, true);
  check("rebound click hit the button", String(await evalOn(`document.getElementById('plain-btn').dataset.hit`)), "1");

  finish();
} catch (err) {
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:\n${app.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(app);
  server.close();
}
