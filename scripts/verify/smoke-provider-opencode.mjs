// Pedido ao vivo (2026-09-04) — worker local (Qwen via llama-server atrás
// de llama-swap, ver ai memory `qwen-buun-local-server`) precisava de um
// agente de terminal real (tool-calling de verdade) em vez de só chat cru;
// `opencode` (sst/opencode) virou provider terminal-spawnável de verdade
// (ProviderId, providers.ts), igual claude/codex/cursor/antigravity.
//
// Ao contrário de smoke-provider-antigravity.mjs (que cobre o binário
// AUSENTE, já que `agy` não estava instalado nesta máquina), `opencode`
// está genuinamente instalado aqui — então a prova real possível é mais
// forte: o processo sobe, fica vivo, e produz output de verdade na PTY
// (via `read_card`, texto real do xterm.js — não uma imagem/OCR).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-provider-opencode-${CDP_PORT}`, import.meta.url).pathname;

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
            const b = document.querySelector('.rail-btn[title="Adicionar card"]');
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
  await bootIntoFreshSession(page, "Provider OpenCode Teste");
  await new Promise((r) => setTimeout(r, 600));

  // ---- 1. UI: opencode aparece no provider picker do popover de terminal ----
  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const opencodeBtnCoords = await centerOf(page, '.provider-picker-btn[title="opencode"]');
  check("opencode aparece no provider picker do popover de terminal", opencodeBtnCoords !== null, true);
  await page.click(opencodeBtnCoords.x, opencodeBtnCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarBtn.x, criarBtn.y);
  await new Promise((r) => setTimeout(r, 3000));

  // ---- 2. binário genuinamente instalado nesta máquina: o card real
  // fica vivo (nunca cai em "terminal-exited") e produz output real. ----
  const exitedText = await page.evalJs(`document.querySelector('[data-role="terminal-exited"]')?.textContent`);
  check("card opencode real (binário instalado) não cai em estado 'saiu' — sobe de verdade", exitedText, undefined);

  const uiCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'opencode').id);
      })()
    `),
  );
  const uiCardText = await toolJson("read_card", { target: uiCardId });
  check("read_card no terminal opencode resolve ok", uiCardText.ok, true);
  check(
    "...e devolve texto REAL não-vazio da PTY (opencode realmente desenhou algo, não uma tela em branco)",
    typeof uiCardText.text === "string" && uiCardText.text.trim().length > 0,
    true,
  );

  // ---- 3. MCP: spawn_agent aceita "opencode" no enum, consent flow real,
  // resolve ok com um cardId de verdade. ----
  async function clickModalButton(label) {
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
    if (!coords) throw new Error(`modal button "${label}" not found`);
    await page.click(coords.x, coords.y);
  }

  const cardsBefore = await page.evalJs(`document.querySelectorAll('[data-kind="terminal"]').length`);
  const bashCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'bash').id);
      })()
    `),
  );

  const spawnPromise = callTool("spawn_agent", { provider: "opencode", callerCardId: bashCardId, reason: "testar provider opencode via MCP" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton("Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent MCP aceita provider opencode e resolve ok com um cardId", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  const cardsAfter = await page.evalJs(`document.querySelectorAll('[data-kind="terminal"]').length`);
  check("um novo terminal card real existe depois do spawn_agent(opencode) aprovado", cardsAfter, cardsBefore + 1);

  page.close();
} finally {
  await stopApp(app);
}
finish();
