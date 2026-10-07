// Live proof: a card that ENDS ITS TURN WITHOUT REPORT is reminded, through the
// SCREEN, even though it never goes quiet.
//
// The shape this proves (and that the byte clock cannot see): a commandcode-like
// TUI draws its spinner (`esc to interrupt`), prints `✻ Worked for 3s`, and then
// REPAINTS its composer forever — `lastActivityAt` never ages, no hook fires.
// With a task linked and no `report` call:
//   1. past the floor the card ITSELF is typed one reminder;
//   2. after one more interval the orchestrator is told, once;
//   3. nothing repeats afterwards — neither message — even though delivering the
//      reminder renews the card's "work granted" anchor.
//
// No real CLI and no token: a tiny fake `commandcode` shim sits ahead on PATH
// (same technique as smoke-terminal-turn-end-pattern.mjs), with an isolated
// $HOME so the real `~/.local/bin/commandcode` cannot be reached. Isolated
// userData and CDP port; never the owner's instance or database.
//
// Timing is the real one (20s floor + 60s interval, 5s scan): ~110s.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-idle-self-reminder-screen-${CDP_PORT}`, import.meta.url).pathname;
const FAKE_BIN_DIR = new URL(`../../.verify-tmp/fake-idle-reminder-bin-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The reminder and the orchestrator pointer, whitespace-stripped (read_card soft-wraps).
const REMINDER_NEEDLE = "Youendedyourturnwithoutcallingthereporttool";
const ORCH_NEEDLE = "idlewithoutcallingreport.";
const squash = (text) => (text ?? "").replace(/\s+/g, "");
const count = (text, needle) => squash(text).split(needle).length - 1;

mkdirSync(FAKE_BIN_DIR, { recursive: true });
writeFileSync(
  `${FAKE_BIN_DIR}/commandcode`,
  [
    "#!/bin/bash",
    'echo "○ Crystallizing…  esc to interrupt • 3s • ↓ 1.0k"',
    "sleep 3",
    'echo "✻ Worked for 3s"',
    "# A TUI that never goes quiet: repaint the composer forever.",
    'while true; do printf "❯ Ask your question...\\n  ? for shortcuts · taste off\\n"; sleep 0.3; done',
    "",
  ].join("\n"),
);
chmodSync(`${FAKE_BIN_DIR}/commandcode`, 0o755);

let mcpUrl = MCP_BASE;
let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  const rpc = JSON.parse(jsonLine);
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}
async function waitFor(fn, { timeoutMs, everyMs = 2000 }) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) return null;
    await delay(everyMs);
  }
}
async function clickModalButton(page, label) {
  const find = async () =>
    JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
        })()
      `),
    );
  const coords = await waitFor(find, { timeoutMs: 8000, everyMs: 100 });
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}` },
  isolatedHome: true,
});
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Idle Self Reminder Screen");
  await delay(500);

  const listed = await callTool("list_cards", {});
  const orchId = listed.cards.find((c) => c.kind === "terminal").id;
  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(orchId)}`;

  const spawnPromise = callTool("spawn_agent", { provider: "commandcode", reason: "smoke idle self-reminder", label: "idle-self-reminder" });
  await clickModalButton(page, "Permitir");
  const spawned = await spawnPromise;
  check("spawn_agent do commandcode (shim) ok", spawned.ok === true && typeof spawned.cardId === "string", true);
  const workerId = spawned.cardId;

  const created = await callTool("create_task", { prompt: "smoke: end the turn without calling report", cardId: workerId, provider: "commandcode" });
  check("create_task + card link ok", created.ok === true && typeof created.taskId === "string", true);

  // The shim ends its turn after ~3s and then repaints forever.
  const worker = async () => (await callTool("read_card", { target: workerId })).text ?? "";
  const orch = async () => (await callTool("read_card", { target: orchId })).text ?? "";
  const ended = await waitFor(async () => (await worker()).includes("Worked for 3s"), { timeoutMs: 20_000, everyMs: 500 });
  check("o shim mostrou o fim de turno na tela", !!ended, true);

  // 1. the card itself is reminded, once, past the 20s floor (+ scan period)
  const reminded = await waitFor(async () => count(await worker(), REMINDER_NEEDLE) >= 1, { timeoutMs: 60_000 });
  check("passo1: o PRÓPRIO card recebeu o lembrete", !!reminded, true);
  check("passo1: o orquestrador ainda NÃO foi avisado (lembrete vem primeiro)", count(await orch(), ORCH_NEEDLE), 0);

  // 2. one more interval without report → the orchestrator, once
  const told = await waitFor(async () => count(await orch(), ORCH_NEEDLE) >= 1, { timeoutMs: 110_000 });
  check("passo2: o orquestrador foi avisado depois do intervalo", !!told, true);

  // 3. no loop: wait several more scans and recount both
  await delay(30_000);
  check("passo3: exatamente UM lembrete ao card", count(await worker(), REMINDER_NEEDLE), 1);
  check("passo3: exatamente UM aviso ao orquestrador", count(await orch(), ORCH_NEEDLE), 1);

  page.close();
} finally {
  await stopApp(app);
}
finish();
