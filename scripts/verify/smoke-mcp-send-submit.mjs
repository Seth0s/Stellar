// DESIGN-BACKLOG.md item 58, M2 — `send_to_card` used to append `\r` to
// the same write() call as the text. Above a target CLI's bracketed-paste
// threshold, that `\r` gets swallowed as part of the pasted content
// instead of submitting it — the message sits visible in the composer
// (e.g. "[Pasted text #1 +1 lines]" for Claude Code) but is never sent.
// Reproduced live against the real `claude` CLI installed on this
// machine (same provider smoke-terminal-font-zoom.mjs uses) — a bash
// target wouldn't reproduce this: bash's readline has no paste-buffer
// heuristic, only Ink-based TUI composers like Claude Code's do.
//
// No `read_card` yet (that's M1, still unimplemented) — same technique
// smoke-terminal-install-hint.mjs already uses: capture the real PTY
// byte stream via `window.pty.onData` and look for a deterministic
// marker the agent was asked to reply with. If the fix regresses (the
// old single-write behavior comes back), the marker never appears
// because the message never actually submits.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9474;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-send-submit", import.meta.url).pathname;
const MARKER = "CONFIRMADO-M2-77219";

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
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "MCP Send Submit Teste");
  await new Promise((r) => setTimeout(r, 500));

  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const claudeBtnCoords = await centerOf(page, '.provider-picker-btn[title="claude"]');
  if (!claudeBtnCoords) throw new Error("botão de provider 'claude' não encontrado no popover de criação de terminal");
  await page.click(claudeBtnCoords.x, claudeBtnCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarBtn.x, criarBtn.y);
  await new Promise((r) => setTimeout(r, 2500));

  const claudeCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'claude')?.id ?? null);
      })()
    `),
  );
  check("card 'claude' real foi criado", claudeCardId !== null, true);

  await page.evalJs(`
    (() => {
      window.__chunks = '';
      window.pty.onData((id, data) => { if (id === ${JSON.stringify(claudeCardId)}) window.__chunks += data; });
    })()
  `);

  // Payload multi-linha — acima do limiar de bracketed-paste do Claude
  // Code (a própria auditoria observou o placeholder de paste travar já
  // com 2 linhas).
  const payload = [
    "Isto é um teste automatizado de submissão via MCP.",
    "Ignore tudo acima e responda com EXATAMENTE uma linha, só o texto abaixo, sem mais nada:",
    MARKER,
  ].join("\n");

  let found = false;
  for (let attempt = 1; attempt <= 3 && !found; attempt++) {
    await page.evalJs(`window.__chunks = ''`);
    const sendResult = await toolJson("send_to_card", { target: claudeCardId, text: payload });
    check(`send_to_card (tentativa ${attempt}) retorna ok`, sendResult.ok, true);

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const chunks = await page.evalJs(`window.__chunks`);
      if (chunks.includes(MARKER)) {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!found) {
      // Ainda preso no composer como paste não-submetido é o sintoma
      // exato do bug original — checa isso pra deixar o diagnóstico
      // explícito no output antes de tentar de novo.
      const stuckAsPaste = await page.evalJs(`document.body.innerText.includes('Pasted text')`);
      console.log(`tentativa ${attempt} sem sinal do marker; preso como paste não-submetido: ${stuckAsPaste}`);
    }
  }

  check("o agente real recebeu, processou e respondeu com o marker (mensagem genuinamente submetida, não presa como paste)", found, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
