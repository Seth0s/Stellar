// DESIGN-BACKLOG.md §2.0 item 5 + P1 ("open_url navigates the WRONG card").
//
// openBrowserFor used to hard-lock one browser card per owner, then (after
// item 5) reused "the first browser owned by the caller by insertion order" —
// arbitrary when the caller owns SEVERAL. Measured live on the IdyPlatform
// board: an agent owning a reference prototype AND a logged-in Admin app had
// the prototype hijacked by every default open_url. This smoke now asserts
// WHICH card changed, not just how many exist:
//   - open_url defaults to reuse (anti-clutter for agents)
//   - with several owned browsers, the default reuses the MOST RECENTLY
//     FOCUSED one (z-order), never the oldest
//   - an explicit `cardId` navigates exactly that card
//   - a bogus / wrong-kind cardId FAILS with a reason and navigates NOTHING
//
// "Which card changed" is read from the RENDERED PAGE (`get_page_text`), not
// the store row: a browser card's stored url is written at creation and is
// not refreshed on later navigation, so the store cannot tell two navigations
// apart. Each step loads a distinct local http page, so the page text is the
// evidence of which offscreen browser actually navigated.
import { createServer } from "node:http";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
  enableAutonomousMode,
} from "./cdp-client.mjs";

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
async function listBrowsers(page, boardId) {
  return JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) =>
        JSON.stringify(cards.filter((c) => c.kind === "browser").map((c) => ({ id: c.id, url: c.cwd, owner: c.provider || null })))
      )
    `),
  );
}
/** The live rendered text of a browser card — what actually proves which card
 * a navigation reached (the store url does not refresh after creation). */
async function pageText(cardId) {
  const r = await toolJson("get_page_text", { target: cardId }, MCP_BASE);
  return r.ok ? String(r.text ?? "") : `ERR:${r.error}`;
}
/** Poll until the card shows `needle` (page load is async), then return text. */
async function waitForText(cardId, needle, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await pageText(cardId);
    if (last.includes(needle)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}
const shows = async (cardId, needle) => (await waitForText(cardId, needle)).includes(needle);

// One page per step so the rendered text alone says which card navigated.
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<h1>${req.url}</h1>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const serverPort = server.address().port;
const urlFor = (name) => `http://127.0.0.1:${serverPort}/${name}`;

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

  // MCP tool descriptions advertise the reuse choice and the explicit target.
  const toolsList = await mcpCall(MCP_BASE, "tools/list", {});
  const openUrl = (toolsList.result?.tools ?? []).find((t) => t.name === "open_url");
  const spawnCard = (toolsList.result?.tools ?? []).find((t) => t.name === "spawn_card");
  check("open_url description mentions reuse", /reuse/i.test(openUrl?.description ?? ""), true);
  check("open_url description mentions the explicit target", /cardId/i.test(openUrl?.description ?? ""), true);
  check("spawn_card description mentions browser creates new / reuse", /reuse|NEW browser|new browser/i.test(spawnCard?.description ?? ""), true);
  check("open_url schema exposes reuse", JSON.stringify(openUrl?.inputSchema ?? {}).includes("reuse"), true);
  check("open_url schema exposes cardId", JSON.stringify(openUrl?.inputSchema ?? {}).includes("cardId"), true);
  check("spawn_card schema exposes reuse", JSON.stringify(spawnCard?.inputSchema ?? {}).includes("reuse"), true);
  check("spawn_card schema exposes cardId", JSON.stringify(spawnCard?.inputSchema ?? {}).includes("cardId"), true);

  // Enable autonomous so open_url / spawn_card resolve without a human click.
  // Shared helper: the toggle moved from the session modal to Settings →
  // Maestro, which is exactly why the old inline sequence broke here.
  await enableAutonomousMode(page);

  // 1) First open_url → creates browser #1 owned by bash.
  const first = await toolJson("open_url", { url: urlFor("one"), reason: "first" }, asBash);
  check("first open_url ok", first.ok && typeof first.cardId === "string", true);
  let browsers = await listBrowsers(page, boardId);
  check("one browser after first open_url", browsers.length, 1);
  check("...owned by the caller card", browsers[0].owner, bashId);
  const browser1 = first.cardId;
  check("browser1 renders its page", await shows(browser1, "/one"), true);

  // 2) Second open_url (default) → reuses browser #1 AND navigates it.
  const second = await toolJson("open_url", { url: urlFor("two"), reason: "reuse default" }, asBash);
  check("second open_url ok", second.ok, true);
  check("...returns the SAME cardId (default reuse)", second.cardId, browser1);
  check("...browser1 is what navigated", await shows(browser1, "/two"), true);
  browsers = await listBrowsers(page, boardId);
  check("still exactly one browser after default reuse", browsers.length, 1);

  // 3) open_url reuse:false → second browser, same owner.
  const third = await toolJson("open_url", { url: urlFor("three"), reuse: false, reason: "explicit new" }, asBash);
  check("open_url reuse:false ok", third.ok && typeof third.cardId === "string", true);
  check("...returns a DIFFERENT cardId", third.cardId !== browser1, true);
  browsers = await listBrowsers(page, boardId);
  check("two browsers after reuse:false", browsers.length, 2);
  check("both owned by the same agent", browsers.every((b) => b.owner === bashId), true);
  const browser2 = third.cardId;
  check("browser2 renders its page", await shows(browser2, "/three"), true);

  // 4) THE BUG: with two owned browsers, the default must reuse the MOST
  // RECENTLY FOCUSED (browser2, created/raised last) — never the oldest
  // (browser1) by insertion order.
  const defaultPick = await toolJson("open_url", { url: urlFor("four"), reason: "default among two" }, asBash);
  check("default open_url among two ok", defaultPick.ok, true);
  check("...picks the most recently focused browser, not the first inserted", defaultPick.cardId, browser2);
  check("...browser2 is what navigated", await shows(browser2, "/four"), true);
  check("...browser1 did NOT navigate (still its own page)", await shows(browser1, "/four"), false);
  check("...still two browsers", (await listBrowsers(page, boardId)).length, 2);

  // 5) EXPLICIT cardId=browser1 → navigates browser1, leaves browser2 alone.
  const explicit = await toolJson("open_url", { url: urlFor("five"), cardId: browser1, reason: "explicit target" }, asBash);
  check("explicit cardId open_url ok", explicit.ok, true);
  check("...returns the requested cardId", explicit.cardId, browser1);
  check("...browser1 is what navigated", await shows(browser1, "/five"), true);
  check("...browser2 did NOT navigate (still /four)", await shows(browser2, "/five"), false);
  check("...browser2 still shows its own /four", await shows(browser2, "/four"), true);

  // 6) A bogus cardId FAILS and navigates NOTHING (never another card).
  const bogus = await toolJson("open_url", { url: urlFor("six"), cardId: "999999", reason: "bogus target" }, asBash);
  check("bogus cardId is refused", bogus.ok === false, true);
  check("...error names the requested id", /999999/.test(bogus.error ?? ""), true);
  await new Promise((r) => setTimeout(r, 400));
  check("...no browser navigated (browser1 still /five)", await shows(browser1, "/six"), false);
  check("...no browser navigated (browser2 still /four)", await shows(browser2, "/six"), false);

  // 7) A cardId that is not a browser (the caller terminal) is refused too.
  const wrongKind = await toolJson("open_url", { url: urlFor("seven"), cardId: bashId, reason: "wrong kind target" }, asBash);
  check("wrong-kind cardId is refused", wrongKind.ok === false, true);
  check("...error says it is not a browser", /not a browser/i.test(wrongKind.error ?? ""), true);
  await new Promise((r) => setTimeout(r, 400));
  check("...browser1 still /five", await shows(browser1, "/five"), true);

  // 8) spawn_card kind:browser → always a NEW card (third browser).
  const spawned = await toolJson("spawn_card", { kind: "browser", url: urlFor("eight"), reason: "spawn new" }, asBash);
  check("spawn_card browser ok", spawned.ok && typeof spawned.cardId === "string", true);
  check("...yet another distinct cardId", ![browser1, browser2].includes(spawned.cardId), true);
  browsers = await listBrowsers(page, boardId);
  check("three browsers after spawn_card", browsers.length, 3);
  check("all three still same owner", browsers.every((b) => b.owner === bashId), true);
  check("the new browser renders its page", await shows(spawned.cardId, "/eight"), true);

  // 9) spawn_card kind:browser reuse:true cardId=browser1 → navigates browser1.
  const spawnReuse = await toolJson(
    "spawn_card",
    { kind: "browser", reuse: true, cardId: browser1, url: urlFor("nine"), reason: "reuse explicit" },
    asBash,
  );
  check("spawn_card reuse:true cardId ok", spawnReuse.ok, true);
  check("...returns the requested cardId", spawnReuse.cardId, browser1);
  check("...browser1 is what navigated", await shows(browser1, "/nine"), true);
  check("...still three browsers (no new one)", (await listBrowsers(page, boardId)).length, 3);

  // 10) Contradictory cardId + reuse:false is refused, not silently resolved.
  const contradiction = await toolJson(
    "open_url",
    { url: urlFor("ten"), cardId: browser1, reuse: false, reason: "contradiction" },
    asBash,
  );
  check("cardId + reuse:false is refused", contradiction.ok === false, true);

  page.close();
} finally {
  await stopApp(app);
  await new Promise((r) => server.close(r));
}
finish();
