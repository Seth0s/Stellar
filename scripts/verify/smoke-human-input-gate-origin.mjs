/**
 * Live proof for the human-input gate origin fix (2026-09-14):
 *   A) unmatched xterm auto replies (mouse SGR) must NOT set hasPendingHumanInput
 *      across a 60s idle window on a real PTY;
 *   B) a real human keystroke WITHOUT newline still holds send_to_card
 *      behind reason "human-input".
 *
 * Uses bash (always available) — the classifier is origin-based, not
 * provider-based. Cursor is what jammed MASTER in production because its
 * TUI emits mouse/focus continuously; the same bytes as origin "auto"
 * must leave the gate open here.
 */
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-human-input-gate-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}

async function dumpGate(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(await window.debugBridge.humanInputGate())`));
}

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_MCP_PORT: String(MCP_PORT) },
});
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Human Input Gate Origin");
  await delay(800);

  const list = await toolJson("list_cards", {});
  const bash = list.cards.find((c) => c.kind === "terminal");
  check("tem card terminal", !!bash, true);
  const id = bash.id;

  // A) flood auto mouse SGR / focus / DSR for ~60s — gate must stay empty.
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    await page.evalJs(`
      (async () => {
        const id = ${JSON.stringify(id)};
        await window.pty.write(id, "\\x1b[<35;16;23M", "auto");
        await window.pty.write(id, "\\x1b[O", "auto");
        await window.pty.write(id, "\\x1b[0n", "auto");
      })()
    `);
    await delay(2000);
  }
  const afterAuto = await dumpGate(page);
  const row = afterAuto?.find((r) => r.id === id);
  check("após 60s de auto: dump existe", !!row, true);
  check("após 60s de auto: hasPendingHumanInput false", row?.hasPendingHumanInput, false);
  check("após 60s de auto: buffer vazio", row?.bufferHex, "");

  // B) real human draft without newline — gate holds.
  await page.evalJs(`
    (async () => {
      await window.pty.write(${JSON.stringify(id)}, "draft-without-enter", "human");
    })()
  `);
  await delay(200);
  const afterHuman = await dumpGate(page);
  const rowH = afterHuman?.find((r) => r.id === id);
  check("humano sem newline: hasPending true", rowH?.hasPendingHumanInput, true);

  const send = await toolJson("send_to_card", { target: id, text: "SHOULD_WAIT_FOR_HUMAN" });
  check("send durante draft: reason human-input", send.reason, "human-input");
  check("send durante draft: queued", send.delivery, "queued");

  // Submit the draft so the smoke does not leave a stuck FIFO.
  await page.evalJs(`
    (async () => {
      await window.pty.write(${JSON.stringify(id)}, "\\r", "human");
    })()
  `);
  await delay(500);
  const cleared = await dumpGate(page);
  const rowC = cleared?.find((r) => r.id === id);
  check("após Enter humano: hasPending false", rowC?.hasPendingHumanInput, false);

  console.log(JSON.stringify({ afterAuto: row, afterHuman: rowH, afterEnter: rowC, send }, null, 2));
} finally {
  await stopApp(app);
}
finish();
