// DESIGN-BACKLOG.md §0, enxutação 2026-09-13 — "`deliverCard` é o único
// motor que confirma por leitura de tela... o conserto é a confirmação,
// não o canal". Locked against the REAL app (real bash PTY, real xterm
// buffer read back through `readcard:request`, real DECSET 2004 stream):
//
//  1. `get_delivery` reports the confirm loop's VERDICT, with the raw
//     `confirm` behind it. Before, it said `delivered` for every settled
//     FIFO item — including one that pressed Enter four times, saw the
//     text still in the composer, cleared it with Ctrl+U and lost it.
//  2. A bash target uses the readline rule + the DECSET 2004 signal. The
//     composer rule read every shell submit as "unsent" (the echoed
//     command stays on screen), so each `send_to_card` into bash cost 4
//     Enters + Ctrl+U. Now: `delivered`, exactly ONE Enter — asserted
//     from the receipt AND from the screen (no extra prompt rows). A
//     SILENT command (`sleep`) is `delivered` too: bash emits `2004l` the
//     instant it accepts the line, so the screen showing nothing below
//     the echo is not read as "stuck" (the first run of this smoke caught
//     exactly that false `failed` on `python3 sink.py`).
//  3. When a foreground program owns stdin (raw-mode python sink that
//     echoes and swallows \r), there is no readline and no way to know
//     what it did with Enter: the honest verdict is `unconfirmed`, with
//     ONE Enter — not three more fed into the program, not `failed`.
//     `failed` (text visibly held by a composer) is locked by
//     tests/unit/message-bus-delivery-outcome.test.ts; no real CLI here
//     can be made to swallow Enter on purpose.
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-delivery-outcome-${CDP_PORT}`, import.meta.url).pathname;
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MARKER = `STELLAR-OUT-${STAMP}`;
const HOLD_TEXT = `HOLD-STELLAR-${STAMP} este texto nunca sera submetido pelo sink`;
const SINK_PATH = join(tmpdir(), `stellar-rawsink-${STAMP}.py`);

// Raw-mode stdin sink: echoes what it gets, drops \r \n and Ctrl+U, exits
// on Ctrl+C. Runs inside the real bash card — the PTY, echo and screen
// read are all real; only the "program that ignores Enter" is stand-in.
writeFileSync(
  SINK_PATH,
  [
    "import os, tty, termios",
    "fd = 0",
    "old = termios.tcgetattr(fd)",
    "tty.setraw(fd)",
    "try:",
    "    while True:",
    "        b = os.read(fd, 1024)",
    "        if not b or b'\\x03' in b:",
    "            break",
    "        os.write(1, b.replace(b'\\r', b'').replace(b'\\n', b'').replace(b'\\x15', b''))",
    "finally:",
    "    termios.tcsetattr(fd, termios.TCSADRAIN, old)",
    "",
  ].join("\n"),
);

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function toolJson(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}
async function settleDelivery(id, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const status = await toolJson("get_delivery", { id });
    if (status.delivery !== "queued") return status;
    if (Date.now() >= deadline) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function sendAndSettle(target, text, ms) {
  const receipt = await toolJson("send_to_card", { target, text });
  if (receipt.delivery !== "queued") throw new Error(`send_to_card did not return a queued receipt: ${JSON.stringify(receipt)}`);
  return settleDelivery(receipt.id, ms);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "Delivery Outcome Teste");
  await new Promise((r) => setTimeout(r, 1500));

  const listPayload = await toolJson("list_cards", {});
  const bash = listPayload.cards?.find((c) => c.kind === "terminal" && c.provider === "bash");
  check("card bash seedado existe", Boolean(bash), true);
  const bashId = bash.id;

  // ---- 1. bash: delivered, one Enter, confirmed from receipt AND screen ----
  const echoStatus = await sendAndSettle(bashId, `echo ${MARKER}`);
  check("bash: entrega assenta como delivered", echoStatus.delivery, "delivered");
  check("bash: confirm.result é sent", echoStatus.confirm?.result, "sent");
  check("bash: exatamente 1 Enter (a regra de composer mandava 4)", echoStatus.confirm?.enters, 1);
  check("bash: composer não foi limpo", echoStatus.confirm?.composerCleared, false);

  // Real screen: after the marker's OUTPUT row there must be exactly one
  // non-empty row (the new prompt). Extra Enters would print extra prompts.
  await new Promise((r) => setTimeout(r, 400));
  const screen = await toolJson("read_card", { target: bashId, lines: 12 });
  const rows = (screen.text ?? "").split("\n");
  const outputRow = rows.findIndex((r) => r.trim() === MARKER);
  check("bash: a saída real do echo apareceu na tela", outputRow >= 0, true);
  const afterOutput = rows.slice(outputRow + 1).filter((r) => r.trim().length > 0);
  check("bash: só o prompt novo depois da saída — nenhum Enter extra", afterOutput.length, 1);

  // ---- 2. silent command: accepted by readline (2004l), nothing on screen ----
  const sleepStatus = await sendAndSettle(bashId, "sleep 2");
  check("bash: comando silencioso (sleep) é delivered pelo sinal 2004l, não failed", sleepStatus.delivery, "delivered");
  check("bash: sleep — 1 Enter só", sleepStatus.confirm?.enters, 1);
  await new Promise((r) => setTimeout(r, 2200));

  // ---- 3. foreground program owns stdin: unconfirmed, not a lie either way ----
  const sinkStatus = await sendAndSettle(bashId, `python3 ${SINK_PATH}`);
  check("subir o sink raw (silencioso) é delivered — readline aceitou a linha", sinkStatus.delivery, "delivered");
  await new Promise((r) => setTimeout(r, 600));

  const holdStatus = await sendAndSettle(bashId, HOLD_TEXT, 20_000);
  check("programa em foreground engolindo Enter: assenta como unconfirmed (não delivered, não failed)", holdStatus.delivery, "unconfirmed");
  check("unconfirmed: confirm.result é unknown", holdStatus.confirm?.result, "unknown");
  check("unconfirmed: um único Enter — nada a mais empurrado pro programa", holdStatus.confirm?.enters, 1);
  check("unconfirmed: o laço esperou as 4 rodadas antes de desistir", holdStatus.confirm?.attempts, 4);
  check("unconfirmed: composer limpo no give-up (comportamento pré-existente, agora visível)", holdStatus.confirm?.composerCleared, true);
  check("unconfirmed: sem reason de hold — não é fila, é veredito", holdStatus.reason, undefined);

  // The sink echoed the text, so it IS on the real screen — the loop's
  // "unknown" came from reading that with no readline signal behind it.
  const holdScreen = await toolJson("read_card", { target: bashId, lines: 6 });
  check("o texto está de fato visível na tela do card", (holdScreen.text ?? "").includes(`HOLD-STELLAR-${STAMP}`), true);

  page.close();
} finally {
  await stopApp(app);
  rmSync(SINK_PATH, { force: true });
}
finish();
