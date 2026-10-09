// Persistent browser partition (Push API), cross-origin navigate on an owned
// card, display-mode standalone emulation, and acbridge spawn-card --reason
// in usage. Born RED before persist:/allowDocumentNav/display-mode/--reason
// existed.
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
const MCP_TOKEN = `verify-persistent-${CDP_PORT}`;
let mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;
let callerCardId = null;
const USER_DATA_DIR = join(tmpdir(), `stellar-verify-browser-persistent-${CDP_PORT}`);
const ACBRIDGE = resolve("resources/bin/acbridge");

// Local VAPID applicationServerKey (uncompressed P-256 point, base64url).
const { publicKey: vapidSpki } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});
const VAPID_PUBLIC = Buffer.from(vapidSpki).subarray(vapidSpki.length - 65).toString("base64url");

let pendingPushBody = null;
const SW_JS = `self.addEventListener('push', (event) => {
  const data = event.data ? event.data.text() : 'empty';
  event.waitUntil(self.registration.showNotification('stellar-push', { body: data }));
});
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'local-vapid-deliver') {
    event.waitUntil(self.registration.showNotification('stellar-push', { body: event.data.body || 'local' }));
  }
});
`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"/><title>push fixture</title></head>
<body>
<h1 id="title">origin-a</h1>
<pre id="out">idle</pre>
<script>
window.__pushState = { permission: null, subscribeError: null, endpoint: null, notified: false, displayStandalone: false };
function b64urlToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const b64std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function boot() {
  window.__pushState.displayStandalone = window.matchMedia('(display-mode: standalone)').matches;
  try {
    const perm = await Notification.requestPermission();
    window.__pushState.permission = perm;
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const keyB64 = await (await fetch('/vapid-public-key')).text();
    const raw = b64urlToUint8(keyB64.trim());
    try {
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
      window.__pushState.endpoint = sub.endpoint;
      document.getElementById('out').textContent = 'subscribed';
    } catch (err) {
      window.__pushState.subscribeError = String(err && err.message ? err.message : err);
      document.getElementById('out').textContent = 'subscribe-fail:' + window.__pushState.subscribeError;
    }
    // Local VAPID test server signals delivery; SW shows the notification
    // (Electron CI has no FCM — prove partition notifications + non-incognito subscribe).
    async function pollDeliver() {
      try {
        const r = await fetch('/pending-push');
        if (r.status === 200) {
          const body = await r.text();
          const sw = await navigator.serviceWorker.ready;
          sw.active && sw.active.postMessage({ type: 'local-vapid-deliver', body });
          window.__pushState.notified = true;
          document.getElementById('out').textContent = 'notified:' + body;
          return;
        }
      } catch (_) {}
      setTimeout(pollDeliver, 200);
    }
    pollDeliver();
  } catch (err) {
    window.__pushState.subscribeError = String(err);
    document.getElementById('out').textContent = 'boot-fail:' + err;
  }
}
boot();
</script>
</body></html>`;

const PAGE_B = `<!doctype html><html><head><meta charset="utf-8"/><title>origin-b</title></head>
<body><h1 id="title">origin-b</h1><p data-role="cross-origin-marker">arrived-b</p></body></html>`;

const serverA = createServer((req, res) => {
  if (req.url === "/sw.js") {
    res.writeHead(200, { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/" });
    res.end(SW_JS);
    return;
  }
  if (req.url === "/vapid-public-key") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(VAPID_PUBLIC);
    return;
  }
  if (req.url === "/pending-push") {
    if (pendingPushBody != null) {
      const body = pendingPushBody;
      pendingPushBody = null;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === "/deliver" && req.method === "POST") {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      pendingPushBody = buf || "vapid-local-ok";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: pendingPushBody }));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE_HTML);
});
const serverB = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE_B);
});
await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
await new Promise((r) => serverB.listen(0, "127.0.0.1", r));
const portA = serverA.address().port;
const portB = serverB.address().port;
const urlA = `http://127.0.0.1:${portA}/`;
const urlB = `http://127.0.0.1:${portB}/`;

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

const { check, finish } = makeChecker();

// --- (4) acbridge usage shows --reason (no app needed) ---
const usage = spawnSync(process.execPath, [ACBRIDGE, "spawn-card"], { encoding: "utf8" });
const usageText = `${usage.stderr || ""}${usage.stdout || ""}`;
check("acbridge spawn-card usage names --reason", /--reason/.test(usageText), true);
check("acbridge spawn-card usage names --persistent", /--persistent/.test(usageText), true);
const usageTop = readFileSync(ACBRIDGE, "utf8");
check("acbridge USAGE string lists spawn-card --reason", /spawn-card[\s\S]*?--reason/.test(usageTop), true);

const appHandle = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_MCP_INTERNAL_TOKEN: MCP_TOKEN },
});
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 800));
  await bootIntoFreshSession(page, "Browser persistent", { spawnTerminal: true });
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

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const listed = JSON.parse(
    await page.evalJs(
      `window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.map((c) => ({ id: c.id, kind: c.kind }))))`,
    ),
  );
  const caller = listed.find((c) => c.kind === "terminal");
  check("terminal caller present", Boolean(caller), true);
  callerCardId = caller.id;
  mcpUrl = `http://127.0.0.1:${CDP_PORT + 40000}/mcp`;

  await enableAutonomousMode(page);

  // --- (1) persistent browser via spawn_card ---
  const spawned = parseToolJson(
    await toolCall("spawn_card", {
      kind: "browser",
      url: urlA,
      persistent: true,
      reason: "smoke persistent Push profile",
    }),
  );
  if (!spawned.ok) console.log("spawn_card persistent error:", JSON.stringify(spawned));
  check("spawn_card persistent ok", spawned.ok === true && typeof spawned.cardId === "string", true);
  const browserId = spawned.cardId;
  await new Promise((r) => setTimeout(r, 1500));

  const profile = JSON.parse(
    await page.evalJs(`window.browser.getProfile(${JSON.stringify(browserId)}).then((r) => JSON.stringify(r))`),
  );
  check("profile kind is persistent", profile.ok === true && profile.kind === "persistent", true);
  check("partition uses persist: prefix", typeof profile.partition === "string" && profile.partition.startsWith("persist:"), true);
  check(
    "partition is scoped to this card id",
    profile.partition === `persist:stellar-browser-${browserId}`,
    true,
  );

  const badge = await page.evalJs(`!!document.querySelector('[data-role="browser-persistent-badge"]')`);
  check("persistent badge visible on card", badge, true);

  async function pageInner(js) {
    const raw = await page.evalJs(
      `window.browser.evalJs(${JSON.stringify(browserId)}, ${JSON.stringify(js)}).then((r) => JSON.stringify(r))`,
    );
    return parseEval(raw);
  }

  // Wait for Push boot (subscribe attempt + permission).
  {
    const deadline = Date.now() + 12000;
    let last = null;
    while (Date.now() < deadline) {
      const got = await pageInner("JSON.stringify(window.__pushState || null)");
      last = parseEval(got?.result);
      if (last && (last.endpoint || last.subscribeError || last.permission)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check("Notification permission granted on persistent partition", last?.permission === "granted", true);
    const incognito =
      typeof last?.subscribeError === "string" && /incognito|does not support the Push API/i.test(last.subscribeError);
    check("Push subscribe does NOT fail with incognito/Push-blocked", incognito, false);
    // endpoint may be null if Chromium lacks a push service; absence of
    // the incognito error is the regression we measured against.
    if (last?.endpoint) check("PushManager.subscribe returned an endpoint", typeof last.endpoint === "string", true);
  }

  // Local VAPID server queues a delivery; page SW shows the notification.
  const deliverRes = await fetch(`http://127.0.0.1:${portA}/deliver`, {
    method: "POST",
    body: "vapid-local-ok",
  });
  check("local VAPID server accepted /deliver", deliverRes.ok, true);
  {
    const deadline = Date.now() + 8000;
    let notified = false;
    while (Date.now() < deadline) {
      const got = await pageInner("JSON.stringify(window.__pushState || null)");
      const st = parseEval(got?.result);
      if (st?.notified === true) {
        notified = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    check("notification received from local VAPID test server", notified, true);
  }

  // --- (3) display-mode standalone ---
  const modeSet = parseToolJson(
    await toolCall("browser_set_display_mode", { target: browserId, mode: "standalone" }),
  );
  check("browser_set_display_mode standalone ok", modeSet.ok === true, true);
  check("matchMedia standalone true after set", modeSet.matchMedia === true, true);
  const mq = parseEval(
    (await pageInner("JSON.stringify({ m: window.matchMedia('(display-mode: standalone)').matches })"))?.result,
  );
  check("page matchMedia('(display-mode: standalone)') is true", mq?.m === true, true);

  // --- (2) cross-origin browser_navigate on OWNED card ---
  const nav = parseToolJson(
    await toolCall("browser_navigate", { target: browserId, url: urlB, expectSelector: "[data-role=cross-origin-marker]" }),
  );
  if (!nav.ok) console.log("cross-origin navigate error:", JSON.stringify(nav));
  check("browser_navigate cross-origin on owned card ok", nav.ok === true, true);
  check("arrival is document-load", nav.arrival === "document-load", true);
  const titleB = parseEval((await pageInner("document.getElementById('title')?.textContent"))?.result);
  check("page is now origin-b on SAME card", titleB === "origin-b" || /origin-b/.test(String(titleB)), true);

  // Tool descriptions agents read
  const toolsList = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${MCP_TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/list", params: {} }),
  }).then(async (r) => {
    const text = await r.text();
    const jsonLine = text.startsWith("event:")
      ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim()
      : text;
    return JSON.parse(jsonLine);
  });
  const tools = toolsList.result?.tools ?? [];
  const navTool = tools.find((t) => t.name === "browser_navigate");
  const spawnTool = tools.find((t) => t.name === "spawn_card");
  const modeTool = tools.find((t) => t.name === "browser_set_display_mode");
  check("browser_navigate description mentions owned cross-origin", /document-load|YOU own|you own/i.test(navTool?.description ?? ""), true);
  check("spawn_card description mentions persistent", /persistent/i.test(spawnTool?.description ?? ""), true);
  check("browser_set_display_mode tool is registered", Boolean(modeTool), true);

  finish();
} catch (err) {
  console.log(`smoke falhou: ${String(err)}`);
  console.log(`stderr do app:\n${appHandle.stderr()}`);
  process.exitCode = 1;
} finally {
  await stopApp(appHandle);
  serverA.close();
  serverB.close();
}
