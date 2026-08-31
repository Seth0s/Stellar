// DESIGN-BACKLOG.md item 60, peça 2 — per-board concurrency cap override.
// Confirms the cap is settable via REAL UI (SessionModal's new numeric
// input, not IPC directly) and that message-bus.ts actually enforces the
// board's own value instead of the DEFAULT_CONCURRENCY_CAP constant.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9556;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-concurrency-cap", import.meta.url).pathname;

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
async function hasModal(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.modal'))`));
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
  await bootIntoFreshSession(page, "Board Cap Teste");
  await new Promise((r) => setTimeout(r, 500));

  const cards = await toolJson("list_cards", {});
  const bashId = cards.cards[0].id;

  // Liga o modo autônomo (pré-condição — o cap só é aplicado dentro dele).
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[title="Editar sessão"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));

  // O input de cap só aparece depois do toggle — confirma que ele existe
  // de verdade no DOM antes de tentar escrever nele.
  check(
    "o input de limite de agentes simultâneos aparece depois de ligar o modo autônomo",
    await page.evalJs(`!!document.querySelector('.concurrency-cap-input')`),
    true,
  );

  // Escreve "1" via setter nativo + evento input (mesmo padrão já usado
  // pro campo de nome de sessão) — digita no input numérico real.
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.concurrency-cap-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '1');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  const cancelBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === 'Cancelar');
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(cancelBtn.x, cancelBtn.y);
  await new Promise((r) => setTimeout(r, 300));

  const mode = await toolJson("board_mode", { target: bashId });
  check("board_mode reflete o cap customizado (1), não o default (3)", mode.concurrencyCap, 1);

  // Com cap=1, o PRIMEIRO spawn autônomo ainda passa...
  const first = await toolJson("spawn_agent", { provider: "claude", callerCardId: bashId, reason: "primeiro, dentro do cap" });
  check("primeiro spawn autônomo (dentro do cap customizado) resolve ok:true", first.ok && typeof first.cardId === "string", true);
  await new Promise((r) => setTimeout(r, 700));

  // ...mas o SEGUNDO já é recusado — com o default (3) ele passaria.
  const second = await toolJson("spawn_agent", { provider: "claude", callerCardId: bashId, reason: "segundo, excede o cap customizado" });
  check("segundo spawn é recusado ao bater o cap customizado (1), não o default (3)", second.ok, false);
  check("...e a mensagem de erro cita o cap customizado (1)", second.error?.includes("(1 agents"), true);
  check("...sem mostrar modal", await hasModal(page), false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
