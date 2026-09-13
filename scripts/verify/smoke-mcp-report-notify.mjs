// Live proof for AGENT-half report notify restore (2026-09-13):
// after `report`, the spawner's PTY must receive the short pointer via
// `enqueueCardDelivery` — no OS popup. Real Electron from `out/main`,
// real spawn, real acbridge report, real scrollback read.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-report-notify-${CDP_PORT}`, import.meta.url).pathname;
const POINTER_NEEDLE = "relatório disponível — chame read_report";

let mcpUrl = MCP_BASE;
let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(mcpUrl, {
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
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
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
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Report Notify Pointer");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  const orchId = listPayload.cards.find((c) => c.kind === "terminal").id;
  check("tem um card orquestrador terminal seedado", typeof orchId === "string", true);
  // Stamp identity on the MCP URL so spawn_agent records a real `spawned`
  // connector (callerCardId in the body is NOT trusted without ?card=).
  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(orchId)}`;

  const spawnPromise = callTool("spawn_agent", { provider: "bash", reason: "smoke report notify pointer" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent ok", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  const workerId = spawnPayload.cardId;
  await new Promise((r) => setTimeout(r, 800));

  const before = await toolJson("read_card", { target: orchId });
  check("read_card orquestrador antes do report", before.ok, true);
  const beforeText = before.text ?? "";

  const reportJson = JSON.stringify({ ok: true, result: "pointer-proof-913" }).replace(/"/g, '\\"');
  await page.evalJs(`window.pty.write(${JSON.stringify(workerId)}, ${JSON.stringify(`acbridge report "${reportJson}"\r`)})`);

  // FIFO delivery may wait briefly on readiness; poll scrollback.
  let afterText = "";
  let sawPointer = false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const after = await toolJson("read_card", { target: orchId });
    afterText = after.text ?? "";
    if (afterText.includes(POINTER_NEEDLE) && afterText.length >= beforeText.length) {
      sawPointer = true;
      break;
    }
  }

  check("ponteiro AGENT-half apareceu no PTY do orquestrador", sawPointer, true);
  check("ponteiro menciona read_report", afterText.includes(POINTER_NEEDLE), true);
  check("corpo do report NÃO vazou pro PTY", !afterText.includes("pointer-proof-913"), true);

  const stored = await toolJson("read_report", { target: workerId });
  check("report persistiu no store", stored.ok && stored.report?.result === "pointer-proof-913", true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
