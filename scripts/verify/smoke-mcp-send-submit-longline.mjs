// DESIGN-BACKLOG.md item 58, M2 follow-up — reported live by the user
// (2026-08-30): a long SINGLE-LINE message (no embedded newlines) sent
// via `send_to_card` to a real `claude` card left the Enter un-submitted
// (stuck as a pasted-text placeholder) even with the M2 fix's fixed
// 80ms delay in place. smoke-mcp-send-submit.mjs's payload is multi-line
// but each line short; this uses a single long line instead, plus a
// warm-up exchange first (the real card that failed wasn't freshly
// created empty — it already had prior context), to match the live
// report as closely as possible. Attempts to reproduce this in an
// isolated instance did NOT reproduce the failure (3 tries, matching
// this project's own "don't chase an unreproducible ghost past 3
// attempts" convention) — but the fixed-delay mechanism was still a bet
// under real load, so `send`'s handler (message-bus.ts) was made
// self-verifying regardless: it now reads the card back after the Enter
// and retries just the Enter (never the text) if a paste placeholder is
// still showing. This test guards that mechanism for this payload shape.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, clickProviderInPicker, openTerminalCreatePopover } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-send-submit-longline-${CDP_PORT}`, import.meta.url).pathname;
const MARKER = "CONFIRMADO-LONGLINE-88301";

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
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
  let res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res && selector.includes(".rail-btn[title=")) {
    const titleMatch = selector.match(/title=["']([^"']+)["']/);
    if (titleMatch) {
      const title = titleMatch[1];
      const addBtn = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector('[data-role="rail-add-card"]');
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (addBtn) {
        await page.click(addBtn.x, addBtn.y);
        await new Promise((r) => setTimeout(r, 250));
        res = JSON.parse(
          await page.evalJs(`
            (() => {
              const el = document.querySelector(\`.popover-row[title="${title}"]\`);
              if (!el) return JSON.stringify(null);
              const r = el.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
      }
    }
  }
  return res;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Send Submit Long Line Teste");
  await new Promise((r) => setTimeout(r, 500));

  // Cria o card "claude" pelo caminho da UI: abre o popover de CRIAÇÃO (o
  // clique que estava aqui era num CARD de terminal, que não abre popover
  // nenhum) e escolhe o provider pelo RÓTULO — ver `clickProviderInPicker`.
  await openTerminalCreatePopover(page);
  await clickProviderInPicker(page, "claude");
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

  // Aquecimento — o card real que falhou ao vivo já tinha histórico
  // anterior, diferente de um terminal recém-criado vazio.
  const warmupResult = await toolJson("send_to_card", { target: claudeCardId, text: "Responda só 'ok' e nada mais." });
  check("aquecimento: send_to_card retorna ok", warmupResult.ok, true);
  {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const chunks = await page.evalJs(`window.__chunks`);
      if (chunks.toLowerCase().includes("ok")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
  await page.evalJs(`window.__chunks = ''`);

  // Réplica da mensagem real que o usuário reportou como travada — uma
  // linha só, sem \n embutido, ~380 caracteres, com acentuação real.
  const payload =
    "Oi, aqui é o Maestro (card que trabalhou no item 60 do DESIGN-BACKLOG.md do Stellar — motor de orquestração completo: fila de spawn, cap configurável, motor de task com auto-disparo, auto-retry, modo autônomo completo). O usuário pediu pra eu te perguntar diretamente: falta algo, do seu ponto de vista, no que já foi implementado ou documentado até agora? " +
    MARKER;

  const sendResult = await toolJson("send_to_card", { target: claudeCardId, text: payload });
  check("send_to_card retorna ok", sendResult.ok, true);

  let found = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const chunks = await page.evalJs(`window.__chunks`);
    if (chunks.includes(MARKER)) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  check("o agente real recebeu, processou e respondeu com o marker (linha longa, submetida de verdade)", found, true);
  check(
    "...e não ficou preso como paste não-submetido",
    await page.evalJs(`document.body.innerText.includes('Pasted text')`),
    false,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
