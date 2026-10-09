// Task 2e16b29c — browser_set_viewport + browser_screenshot + snapshot path.
// Born RED before the tools existed (unknown cmd / missing path on MCP snapshot).
// Proof: same card, media query at 640px → mobile label at 375, desktop at 1440.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_TOKEN = `verify-viewport-${CDP_PORT}`;
let mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
let callerCardId = null;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-viewport-${CDP_PORT}`);
const OUT_DIR = join(tmpdir(), `stellar-viewport-shots-${CDP_PORT}`);
mkdirSync(OUT_DIR, { recursive: true });

let nextRpcId = 1;
async function toolCall(name, args) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${MCP_TOKEN}`,
  };
  if (callerCardId) headers["x-stellar-caller-card"] = callerCardId;
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
    : text;
  const rpc = JSON.parse(jsonLine);
  if (rpc.error) return { ok: false, error: JSON.stringify(rpc.error), raw: rpc };
  return rpc.result;
}

function parseToolJson(result) {
  const textBlock = result?.content?.find((c) => c.type === "text");
  if (!textBlock?.text) return { ok: false, error: "no text content", result };
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return { ok: false, error: textBlock.text };
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

const FIXTURE = `<!doctype html><html><head>
<meta charset="utf-8"/>
<style>
  body { margin: 0; font-family: sans-serif; }
  #label { padding: 24px; font-size: 28px; }
  #marker { display: none; padding: 8px; background: #eee; }
  @media (max-width: 640px) {
    #label { color: #c00; }
    #label::after { content: " MOBILE"; }
    #marker { display: block; }
  }
  @media (min-width: 641px) {
    #label { color: #060; }
    #label::after { content: " DESKTOP"; }
  }
  #tall { height: 2200px; background: linear-gradient(#fff, #cdf); }
</style>
</head><body>
  <div id="label" data-role="viewport-label">layout</div>
  <div id="marker" data-role="mobile-marker">narrow</div>
  <div id="tall" data-role="tall-block">tall</div>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const fixtureUrl = `http://127.0.0.1:${port}/`;

const { check, finish } = makeChecker();
const appHandle = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_MCP_INTERNAL_TOKEN: MCP_TOKEN },
});
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 800));
  await bootIntoFreshSession(page, "Browser viewport", { spawnTerminal: true });
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
  const browser = listed.find((c) => c.kind === "browser");
  check("spawned a browser card and a terminal caller", Boolean(caller && browser), true);
  callerCardId = caller.id;
  // ?card= stamps are refused — same Bearer + caller-header path the Unix relay uses.
  mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;

  await page.evalJs(`window.browser.navigate(${JSON.stringify(browser.id)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 1200));

  async function pageInner(js) {
    const raw = await page.evalJs(
      `window.browser.evalJs(${JSON.stringify(browser.id)}, ${JSON.stringify(js)}).then((r) => JSON.stringify(r))`,
    );
    return parseEval(raw);
  }

  function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "number") return parsed;
        return Number(parsed);
      } catch {
        return Number(value);
      }
    }
    return Number(value);
  }

  async function waitInnerWidth(expected, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const got = await pageInner("window.innerWidth");
      const n = asNumber(got?.result);
      if (got?.ok && n === Number(expected)) return n;
      await new Promise((r) => setTimeout(r, 150));
    }
    const last = await pageInner("window.innerWidth");
    throw new Error(`innerWidth never reached ${expected} (last=${JSON.stringify(last)})`);
  }

  // --- viewport 375 (mobile) ---
  const setMobile = parseToolJson(
    await toolCall("browser_set_viewport", { target: browser.id, width: 375, height: 812 }),
  );
  if (!setMobile.ok) console.log("set_viewport 375 error:", JSON.stringify(setMobile));
  check("browser_set_viewport 375 returns ok", setMobile.ok, true);
  await waitInnerWidth(375);
  // ::after content is not in textContent — assert matchMedia at the breakpoint.
  const mobileMq = parseEval(
    (await pageInner("JSON.stringify({ m: window.matchMedia('(max-width: 640px)').matches })"))?.result,
  );
  check("media query at 375 shows MOBILE", mobileMq?.m === true, true);
  const badge375 = await page.evalJs(
    `!!document.querySelector('[data-role="browser-emulation-badge"]')`,
  );
  check("emulation badge visible at 375", badge375, true);

  // --- same card → 1440 (desktop) ---
  const setDesk = parseToolJson(
    await toolCall("browser_set_viewport", { target: browser.id, width: 1440, height: 900, mobile: false }),
  );
  check("browser_set_viewport 1440 returns ok", setDesk.ok, true);
  await waitInnerWidth(1440);
  const deskMq = parseEval(
    (await pageInner("JSON.stringify({ m: window.matchMedia('(max-width: 640px)').matches })"))?.result,
  );
  check("media query at 1440 shows DESKTOP on SAME card", deskMq?.m === false, true);

  // --- screenshot fullPage + out ---
  const fullOut = join(OUT_DIR, "full.png");
  const shot = parseToolJson(
    await toolCall("browser_screenshot", {
      target: browser.id,
      fullPage: true,
      out: fullOut,
    }),
  );
  check("browser_screenshot fullPage ok", shot.ok, true);
  check("browser_screenshot returns the out path", shot.path, fullOut);
  check("fullPage PNG exists on disk", existsSync(fullOut), true);
  check("fullPage PNG is non-trivial", existsSync(fullOut) && statSync(fullOut).size > 1000, true);

  // --- element crop ---
  const elOut = join(OUT_DIR, "label.png");
  const elShot = parseToolJson(
    await toolCall("browser_screenshot", {
      target: browser.id,
      selector: "#label",
      out: elOut,
    }),
  );
  check("browser_screenshot selector ok", elShot.ok, true);
  check("element PNG exists", existsSync(elOut) && statSync(elOut).size > 100, true);

  // --- MCP snapshot returns path + image ---
  const snapOut = join(OUT_DIR, "mcp-snap.png");
  const snapResult = await toolCall("snapshot", { target: browser.id, out: snapOut });
  const snapJson = parseToolJson(snapResult);
  const hasImage = Array.isArray(snapResult?.content) && snapResult.content.some((c) => c.type === "image");
  check("MCP snapshot JSON includes path", snapJson.ok === true && snapJson.path === snapOut, true);
  check("MCP snapshot still embeds image", hasImage, true);
  check("MCP snapshot --out file exists", existsSync(snapOut), true);

  // --- reset ---
  const reset = parseToolJson(await toolCall("browser_set_viewport", { target: browser.id, reset: true }));
  check("browser_set_viewport reset ok", reset.ok, true);
  await new Promise((r) => setTimeout(r, 400));
  const afterReset = await page.evalJs(
    `!!document.querySelector('[data-role="browser-emulation-badge"]')`,
  );
  check("emulation badge gone after reset", afterReset, false);

  // Sanity: PNG header
  const png = readFileSync(fullOut);
  check("fullPage file starts with PNG magic", png[0] === 0x89 && png[1] === 0x50, true);
  finish();
} catch (err) {
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:\n${appHandle.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(appHandle);
  server.close();
}
