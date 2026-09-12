// DESIGN-BACKLOG.md §2.0 item 5 — openBrowserFor used to hard-lock one
// browser card per owner. Reuse is now a caller choice:
//   - open_url defaults to reuse (anti-clutter for agents)
//   - open_url reuse:false / spawn_card kind:browser always opens new
//   - humans (null owner) always open new
// Verifies against a real Electron build via MCP + DOM/store, not mocks.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-owner-reuse-${CDP_PORT}`, import.meta.url).pathname;

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
async function callTool(name, args, url) {
  const rpc = await mcpCall(url, "tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args, url) {
  return JSON.parse((await callTool(name, args, url)).content[0].text);
}
async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
}
async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}
async function listBrowsers(page, boardId) {
  return JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) =>
        JSON.stringify(cards.filter((c) => c.kind === "browser").map((c) => ({ id: c.id, url: c.cwd, owner: c.provider || null })))
      )
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Owner Reuse §2.0.5");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const bashId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) =>
        JSON.stringify(cards.find((c) => c.kind === "terminal")?.id ?? null)
      )
    `),
  );
  check("bash seed card id resolved", typeof bashId === "string" && bashId.length > 0, true);
  const asBash = `${MCP_BASE}?card=${encodeURIComponent(bashId)}`;

  // MCP tool descriptions advertise the reuse choice (agent-facing surface).
  const toolsList = await mcpCall(MCP_BASE, "tools/list", {});
  const openUrl = (toolsList.result?.tools ?? []).find((t) => t.name === "open_url");
  const spawnCard = (toolsList.result?.tools ?? []).find((t) => t.name === "spawn_card");
  check("open_url description mentions reuse", /reuse/i.test(openUrl?.description ?? ""), true);
  check("spawn_card description mentions browser creates new / reuse", /reuse|NEW browser|new browser/i.test(spawnCard?.description ?? ""), true);
  check("open_url schema exposes reuse", JSON.stringify(openUrl?.inputSchema ?? {}).includes("reuse"), true);
  check("spawn_card schema exposes reuse", JSON.stringify(spawnCard?.inputSchema ?? {}).includes("reuse"), true);

  // Enable autonomous so open_url / spawn_card resolve without a human click.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[data-role="edit-session"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));
  await clickModalButton(page, "Cancelar");
  await new Promise((r) => setTimeout(r, 400));

  // 1) First open_url → creates browser owned by bash.
  const first = await toolJson("open_url", { url: "data:text/html,<h1>one</h1>", reason: "first" }, asBash);
  check("first open_url ok", first.ok && typeof first.cardId === "string", true);
  await new Promise((r) => setTimeout(r, 400));
  let browsers = await listBrowsers(page, boardId);
  check("one browser after first open_url", browsers.length, 1);
  check("...owned by the caller card", browsers[0].owner, bashId);
  const firstId = first.cardId;

  // 2) Second open_url (default) → reuses same card (anti-clutter).
  const second = await toolJson("open_url", { url: "data:text/html,<h1>two</h1>", reason: "reuse default" }, asBash);
  check("second open_url ok", second.ok, true);
  check("...returns the SAME cardId (default reuse)", second.cardId, firstId);
  await new Promise((r) => setTimeout(r, 400));
  browsers = await listBrowsers(page, boardId);
  check("still exactly one browser after default reuse", browsers.length, 1);

  // 3) open_url reuse:false → second browser, same owner.
  const third = await toolJson(
    "open_url",
    { url: "data:text/html,<h1>three</h1>", reuse: false, reason: "explicit new" },
    asBash,
  );
  check("open_url reuse:false ok", third.ok && typeof third.cardId === "string", true);
  check("...returns a DIFFERENT cardId", third.cardId !== firstId, true);
  await new Promise((r) => setTimeout(r, 400));
  browsers = await listBrowsers(page, boardId);
  check("two browsers after reuse:false", browsers.length, 2);
  check("both owned by the same agent", browsers.every((b) => b.owner === bashId), true);

  // 4) spawn_card kind:browser → third browser (always new).
  const spawned = await toolJson(
    "spawn_card",
    { kind: "browser", url: "data:text/html,<h1>four</h1>", reason: "spawn new" },
    asBash,
  );
  check("spawn_card browser ok", spawned.ok && typeof spawned.cardId === "string", true);
  check("...yet another distinct cardId", ![firstId, third.cardId].includes(spawned.cardId), true);
  await new Promise((r) => setTimeout(r, 400));
  browsers = await listBrowsers(page, boardId);
  check("three browsers after spawn_card", browsers.length, 3);
  check("all three still same owner", browsers.every((b) => b.owner === bashId), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
