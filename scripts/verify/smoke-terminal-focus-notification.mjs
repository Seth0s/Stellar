// Fixes the false-positive "X terminou o turno" notification: when the
// user is actively typing in a focused terminal (top of z-order + window
// has OS focus), the notification should be suppressed. Only when a
// terminal is NOT the topmost card should the notification fire.
//
// Test strategy:
//   1. Mock window.Notification before boot.
//   2. Single terminal (isFocused=true): trigger activity → idle → assert
//      NO notification.
//   3. MCP spawn_agent a second bash terminal (raises to top): trigger
//      activity on the first terminal (now isFocused=false) → assert
//      notification IS called.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-focus-notification-${Date.now()}`, import.meta.url).pathname;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT + 40000}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
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

  // Inject mock Notification BEFORE boot — the auto-seeded terminal
  // mounts during bootIntoFreshSession, so the mock must be ready first.
  await page.evalJs(`
    window.__notificationCalls = [];
    window.Notification = class {
      constructor(title, options) {
        window.__notificationCalls.push({ title, options });
      }
    };
  `);

  await bootIntoFreshSession(page, "Focus Notification Test");
  await delay(600);

  // Get the first (auto-seeded) terminal card id.
  const listPayload = await toolJson("list_cards", {});
  const firstCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  // Wait for initial PTY output to settle (spawn output triggers isActive).
  await delay(1500);

  // ---- CASE 1: Single terminal (isFocused=true) — no notification ----
  // Write something that produces output, triggering the isActive=true
  // → idle (900ms silence) → isActive=false transition.
  await page.evalJs(
    `window.pty.write(${JSON.stringify(firstCardId)}, ${JSON.stringify("echo case1-activity-proof\\n")})`,
  );
  // Wait for ACTIVITY_IDLE_MS (900ms) + buffer for the effect to run.
  await delay(1600);

  const case1Calls = JSON.parse(
    await page.evalJs(`JSON.stringify(window.__notificationCalls)`),
  );
  check(
    "CASE 1 — single focused terminal: NO notification on activity idle",
    case1Calls.length,
    0,
  );

  // ---- CASE 2: Spawn a second terminal on top via MCP ----
  // Spawning through MCP properly adds the card to the store and updates
  // React state, giving the new card the highest z-index.
  const spawnPromise = callTool("spawn_agent", {
    provider: "bash",
    callerCardId: firstCardId,
    reason: "smoke test: second terminal to lower first card z-order",
  });
  await delay(500);
  await clickModalButton(page, "Permitir");
  const spawnPayload = await spawnPromise.then((r) => JSON.parse(r.content[0].text));
  check("CASE 2 — spawn_agent resolves ok", spawnPayload.ok, true);

  const secondCardId = spawnPayload.cardId;
  await delay(1200); // let second terminal mount and settle

  // Confirm two terminals exist.
  const terminalCount = await page.evalJs(`document.querySelectorAll('[data-kind="terminal"]').length`);
  check("CASE 2 — two terminal cards rendered", terminalCount, 2);

  // Trigger activity on the FIRST terminal (now isFocused=false).
  await page.evalJs(
    `window.pty.write(${JSON.stringify(firstCardId)}, ${JSON.stringify("echo case2-activity-proof\\n")})`,
  );
  // Wait for ACTIVITY_IDLE_MS (900ms) + buffer.
  await delay(1600);

  const case2Calls = JSON.parse(
    await page.evalJs(`JSON.stringify(window.__notificationCalls)`),
  );
  check(
    "CASE 2 — background terminal: notification fires on activity idle",
    case2Calls.length,
    1,
  );
  check(
    "CASE 2 — notification title references the card",
    case2Calls[0]?.title?.includes("terminou o turno"),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
