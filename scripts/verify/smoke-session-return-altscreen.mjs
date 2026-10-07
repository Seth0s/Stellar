// A TUI in the alternate screen survives leaving the session and coming back.
//
// The ring that main keeps per card is cut from the FRONT at 2 MB. An agent CLI is a
// TUI: it enters the alternate screen once (ESC[?1049h), turns on mouse tracking and
// bracketed paste, and then only repaints with cursor addressing. When the cut
// removes the entry, the replay drew those cursor-addressed repaints into a fresh
// xterm's NORMAL buffer, in the wrong modes. This smoke reproduces it with a script
// that does what a TUI does and prints more than 2 MB after entering:
//   - the xterm after the return must be in the alternate buffer, with mouse
//     tracking, bracketed paste and application cursor keys as the app set them;
//   - the final frame must be drawn where the app addressed it.
// Bash card only (no CLI, no token). Isolated userData and port.
import { mkdirSync, writeFileSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-session-return-altscreen-${CDP_PORT}`, import.meta.url).pathname;
const GEN_DIR = new URL(`../../.verify-tmp/session-return-altscreen-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The TUI: enter alt screen, hide the cursor, mouse tracking 1002 + SGR encoding, bracketed
// paste, application cursor keys; ~2.6 MB of cursor-addressed repaints (no newlines, like a
// real TUI redraw); a final frame; then stay alive in the alternate screen.
mkdirSync(GEN_DIR, { recursive: true });
writeFileSync(
  `${GEN_DIR}/tui.sh`,
  `#!/bin/sh
printf '\\033[?1049h\\033[?25l\\033[?1002h\\033[?1006h\\033[?2004h\\033[?1h'
awk 'BEGIN {
  pad = "................................................................................"
  for (i = 1; i <= 30000; i++) {
    row = (i % 20) + 1
    printf "\\033[%d;1H\\033[2KREPAINT%06d %s", row, i, pad
  }
  printf "\\033[1;1H\\033[2K\\033[3;10HFINAL_FRAME_OK"
}'
printf '\\033[2;1HTUI_READY'
exec sleep 600
`,
);

let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(MCP_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  const rpc = JSON.parse(line);
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}
async function waitFor(fn, { timeoutMs, everyMs = 500 }) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) return null;
    await delay(everyMs);
  }
}
async function goHome(page) {
  const c = JSON.parse(await page.evalJs(`(() => { const el = document.querySelector('.topbar-home'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`));
  await page.click(c.x, c.y);
  await waitFor(async () => page.evalJs(`!!document.querySelector('.home')`), { timeoutMs: 8000, everyMs: 100 });
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Altscreen Return");
  await delay(600);
  const cardId = (await callTool("list_cards", {})).cards.find((c) => c.kind === "terminal").id;
  const modes = () => page.evalJs(`JSON.stringify(window.__getTerminalModes(${JSON.stringify(cardId)}))`).then(JSON.parse);

  await callTool("send_to_card", { target: cardId, text: `sh ${GEN_DIR}/tui.sh` });
  const ready = await waitFor(async () => ((await callTool("read_card", { target: cardId, lines: 200 })).text ?? "").includes("TUI_READY"), { timeoutMs: 120_000, everyMs: 1000 });
  check("o TUI terminou de desenhar (mais de 2 MB depois de entrar na tela alternativa)", !!ready, true);

  const before = await modes();
  console.log("[measured] modes before leaving:", JSON.stringify(before));
  check("antes de sair: tela alternativa, mouse 1002, bracketed paste e teclas de cursor da aplicação ligados",
    before?.buffer === "alternate" && before?.mouseTrackingMode === "drag" && before?.bracketedPasteMode === true && before?.applicationCursorKeysMode === true, true);

  await goHome(page);
  await delay(3000);
  const open = await page.evalJs(`(() => { const b = [...document.querySelectorAll('.home button')].find((x) => x.textContent.includes("Altscreen Return")); if (!b) return false; b.click(); return true; })()`);
  check("voltou ao board", open, true);
  await waitFor(async () => (await modes()) !== null, { timeoutMs: 15_000, everyMs: 300 });
  await delay(4000); // the replay is parsed in slices by xterm

  const after = await modes();
  console.log("[measured] modes after return:", JSON.stringify(after));
  check("depois da volta: o xterm está na TELA ALTERNATIVA", after?.buffer, "alternate");
  check("depois da volta: mouse tracking 1002 (drag) restaurado", after?.mouseTrackingMode, "drag");
  check("depois da volta: bracketed paste restaurado", after?.bracketedPasteMode, true);
  check("depois da volta: teclas de cursor da aplicação restauradas", after?.applicationCursorKeysMode, true);

  const text = (await callTool("read_card", { target: cardId, lines: 200 })).text ?? "";
  const finalRow = text.split("\n").find((l) => l.includes("FINAL_FRAME_OK")) ?? "";
  check("o quadro final está desenhado onde a aplicação o endereçou (linha 3, coluna 10)", finalRow.indexOf("FINAL_FRAME_OK") === 9, true);
  page.close();
} finally {
  await stopApp(app);
}
finish();
