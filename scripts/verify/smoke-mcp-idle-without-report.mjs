// Live proof for SINAL 3 (idle without report):
// 1) card with linked task goes quiet without calling report
// 2) spawner receives the idle pointer once
// 3) worker then reports
// 4) further idle does NOT re-fire the idle pointer
//
// Floor is IDLE_WITHOUT_REPORT_MS = 180_000 (idle-without-report-decision.ts),
// same ceiling as ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS. Real Electron + task link.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const IDLE_WITHOUT_REPORT_MS = 180_000;
const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-idle-without-report-${CDP_PORT}`, import.meta.url).pathname;
const IDLE_POINTER_NEEDLE = "idle sem chamar report";
const REPORT_POINTER_NEEDLE = "relatório disponível — chame read_report";

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

function idleCount(text) {
  const re = new RegExp(IDLE_POINTER_NEEDLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return (text.match(re) || []).length;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Idle Without Report Watchdog");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  const orchId = listPayload.cards.find((c) => c.kind === "terminal").id;
  check("tem um card orquestrador terminal seedado", typeof orchId === "string", true);
  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(orchId)}`;

  const spawnPromise = callTool("spawn_agent", {
    provider: "bash",
    reason: "smoke idle without report",
    label: "idle-wo-report",
  });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent ok", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  const workerId = spawnPayload.cardId;
  await new Promise((r) => setTimeout(r, 800));

  // create_task with cardId links the principal implementer (same path as auto-retry smoke).
  const created = await toolJson("create_task", {
    prompt: "smoke: finish without report then report",
    cardId: workerId,
    provider: "bash",
  });
  check("create_task + card link ok", created.ok && typeof created.taskId === "string", true);

  const before = await toolJson("read_card", { target: orchId });
  check("read_card orquestrador antes do idle", before.ok, true);
  let orchText = before.text ?? "";

  // Steps 1+2: quiet past the 180s floor → one idle pointer on the spawner.
  let sawIdlePointer = false;
  const idleDeadline = Date.now() + IDLE_WITHOUT_REPORT_MS + 20_000;
  while (Date.now() < idleDeadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const read = await toolJson("read_card", { target: orchId });
    orchText = read.text ?? "";
    if (idleCount(orchText) >= 1) {
      sawIdlePointer = true;
      break;
    }
  }
  check("passo1+2: ponteiro idle-sem-report no PTY do orquestrador", sawIdlePointer, true);
  check("passo2: exatamente um ponteiro idle", idleCount(orchText), 1);

  const empty = await toolJson("read_report", { target: workerId });
  check("passo1: read_report vazio antes do report formal", empty.ok === false, true);

  // Step 3: formal report via acbridge. Prefer send_to_card (FIFO + Enter
  // confirm) over a bare pty.write after a 180s idle — long silence can
  // leave the paste path racing the prompt.
  const reportJson = JSON.stringify({ ok: true, result: "idle-watchdog-proof" });
  const send = await toolJson("send_to_card", {
    target: workerId,
    text: `acbridge report '${reportJson}'`,
  });
  check("passo3: send_to_card enfileirou o acbridge report", send.ok === true, true);

  let stored = { ok: false };
  const reportDeadline = Date.now() + 20_000;
  while (Date.now() < reportDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    stored = await toolJson("read_report", { target: workerId });
    if (stored.ok) break;
  }
  if (!stored.ok) {
    const workerScroll = await toolJson("read_card", { target: workerId });
    console.error("worker scrollback after failed report:\n", (workerScroll.text ?? "").slice(-800));
  }
  check("passo3: report persistiu", stored.ok && stored.report?.result === "idle-watchdog-proof", true);

  let sawReportPointer = false;
  const pointerDeadline = Date.now() + 12_000;
  while (Date.now() < pointerDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    const read = await toolJson("read_card", { target: orchId });
    orchText = read.text ?? "";
    if (orchText.includes(REPORT_POINTER_NEEDLE)) {
      sawReportPointer = true;
      break;
    }
  }
  check("passo3: ponteiro de relatório no orquestrador", sawReportPointer, true);
  check("passo3: idle pointer ainda exatamente um", idleCount(orchText), 1);

  // Step 4: several poll ticks after report — has_report must keep the idle pointer from re-firing.
  // No need to wait another 180s: the gate short-circuits on hasReport.
  await new Promise((r) => setTimeout(r, 20_000));
  const finalRead = await toolJson("read_card", { target: orchId });
  check("passo4: idle pointer NÃO se repetiu após report", idleCount(finalRead.text ?? ""), 1);

  page.close();
} finally {
  await stopApp(app);
}
finish();
