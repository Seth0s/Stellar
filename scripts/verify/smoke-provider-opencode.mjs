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
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, clickProviderInPicker, openTerminalCreatePopover } from "./cdp-client.mjs";

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
  await bootIntoFreshSession(page, "Provider OpenCode Teste");
  await new Promise((r) => setTimeout(r, 600));

  // Contador de bytes do PTY, pelo mesmo canal que o xterm.js consome. Não é
  // a checagem — é o diagnóstico que faltava: se o `read_card` voltar vazio,
  // a diferença entre "0 byte" (o PTY nunca recebeu nada) e "18 kB" (a TUI
  // desenhou e o texto ainda não estava na tela) é a diferença entre acusar
  // o app e acusar a amostra.
  await page.evalJs(`
    (() => {
      window.__bytes = {};
      window.pty.onData((id, data) => { window.__bytes[id] = (window.__bytes[id] ?? "") + data; });
    })()
  `);

  // ---- 1. UI: opencode aparece no provider picker do popover de terminal ----
  // Abre o popover de CRIAÇÃO (rail → "Adicionar card" → Terminal): o clique
  // que estava aqui era num CARD de terminal, que não abre popover nenhum.
  await openTerminalCreatePopover(page);
  const pickerLabels = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('.provider-picker-btn')].map((b) => b.textContent.trim()))`),
  );
  check("opencode aparece no provider picker do popover de terminal", pickerLabels.includes("OpenCode"), true);
  await clickProviderInPicker(page, "opencode");
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
  // A tela do opencode é uma TUI em TELA ALTERNATIVA: o primeiro quadro é
  // fundo pintado (linhas só com espaços, que `translateToString(true)`
  // devolve como vazio) e o texto só aparece quando a TUI termina de
  // desenhar. Medido em 2026-09-22 (task 71128571, com
  // investigate-real-binary-pty.mjs): a PTY entrega 18007 bytes e o
  // `read_card` devolve 0 caractere em t≈1,7s, 3936 a partir de t≈3,7s. A
  // versão anterior fazia UMA leitura em t≈3,2s e acusava o app pelo que
  // era o instante da amostra — agora ela ESPERA, com teto, em vez de
  // amostrar uma vez.
  let uiCardText = { ok: false, text: "" };
  const readDeadline = Date.now() + 30000;
  while (Date.now() < readDeadline) {
    uiCardText = await toolJson("read_card", { target: uiCardId });
    if (typeof uiCardText.text === "string" && uiCardText.text.trim().length > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check("read_card no terminal opencode resolve ok", uiCardText.ok, true);
  const uiCardTextLen = typeof uiCardText.text === "string" ? uiCardText.text.trim().length : -1;
  const uiCardBytes = await page.evalJs(`(window.__bytes[${JSON.stringify(uiCardId)}] ?? "").length`);
  console.log(`  medido: ${uiCardBytes} bytes entregues pela PTY, ${uiCardTextLen} caracteres no buffer do card`);
  check(
    "...e devolve texto REAL não-vazio da PTY (opencode realmente desenhou algo, não uma tela em branco)",
    uiCardTextLen > 0,
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
