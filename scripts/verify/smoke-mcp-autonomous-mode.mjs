// DESIGN-BACKLOG.md item 59 — opt-in autonomous mode. The human-in-the-
// loop path (every spawn_agent shows AgentAskModal) stays the default
// everywhere; this is the second, explicit, per-board opt-in path that
// coexists with it. Every consent-architecture claim here is checked
// against the real DOM (.modal presence/absence), not just the MCP
// response — a wrong auto-approve that skips the modal only shows up if
// you actually look for the modal.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9545;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-autonomous-mode", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Board 1 Autônomo Teste");
  await new Promise((r) => setTimeout(r, 500));

  const board1Cards = await toolJson("list_cards", {});
  const board1BashId = board1Cards.cards[0].id;

  const modeBefore = await toolJson("board_mode", { target: board1BashId });
  check("board novo nasce com autonomous:false, nunca herdado", JSON.stringify(modeBefore), JSON.stringify({ ok: true, autonomous: false }));

  // Baseline: com o modo desligado (padrão), spawn_agent ainda mostra o
  // modal — sem regressão no fluxo human-in-the-loop.
  const baselinePromise = callTool("spawn_agent", { provider: "bash", callerCardId: board1BashId, reason: "baseline" });
  await new Promise((r) => setTimeout(r, 500));
  check("com o modo desligado, spawn_agent ainda mostra o AgentAskModal", await hasModal(page), true);
  await clickModalButton(page, "Negar");
  await baselinePromise;
  await new Promise((r) => setTimeout(r, 300));

  // Liga o modo autônomo via UI REAL — clique no título do topbar, lápis
  // de editar, checkbox, fechar. Nenhuma tool MCP faz isso.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[title="Editar sessão"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
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

  const modeAfter = await toolJson("board_mode", { target: board1BashId });
  check("depois do clique real na UI, board_mode reflete autonomous:true", modeAfter.autonomous, true);
  check(
    "o indicador visual real aparece no Topbar",
    await page.evalJs(`document.querySelector('.topbar-autonomous-badge')?.textContent`),
    "autônomo",
  );

  // Em modo autônomo, spawn_agent do MESMO board resolve na hora, SEM
  // modal — até bater o teto de concorrência (default 3, só agentes
  // não-bash contam).
  const autoSpawnedIds = [];
  for (let i = 0; i < 3; i++) {
    const result = await toolJson("spawn_agent", { provider: "claude", callerCardId: board1BashId, reason: `autônomo #${i + 1}` });
    check(`spawn autônomo #${i + 1} resolve ok:true sem modal`, result.ok && typeof result.cardId === "string", true);
    check(`...e nenhum modal apareceu depois dele`, await hasModal(page), false);
    autoSpawnedIds.push(result.cardId);
    // Dá tempo real do processo (registry.spawn, main process) registrar
    // antes do próximo spawn checar o teto de concorrência — sem isso o
    // teto contaria menos processos vivos do que realmente existem.
    await new Promise((r) => setTimeout(r, 700));
  }

  // Teto batido — recusa estrutural (sem modal, sem fila), só em modo autônomo.
  const overCap = await toolJson("spawn_agent", { provider: "claude", callerCardId: board1BashId, reason: "excede o teto" });
  check("ao bater o teto de concorrência em modo autônomo, o 4º spawn é recusado", overCap.ok, false);
  check("...sem mostrar modal", await hasModal(page), false);

  // MAX_SPAWN_DEPTH continua valendo, mesmo em modo autônomo.
  const depthGuard = await toolJson("spawn_agent", { provider: "bash", callerCardId: board1BashId, depth: 3 });
  check("MAX_SPAWN_DEPTH ainda recusa em modo autônomo (razão distinta do teto de concorrência)", depthGuard.error?.includes("depth"), true);

  // open_url e spawn_card continuam pedindo consentimento em modo autônomo
  // — o auto-approve é só pra spawn_agent.
  const openPromise = callTool("open_url", { url: "https://example.com", callerCardId: board1BashId, reason: "smoke item 59" });
  await new Promise((r) => setTimeout(r, 500));
  check("open_url AINDA mostra o modal mesmo em modo autônomo", await hasModal(page), true);
  await clickModalButton(page, "Permitir");
  await openPromise;
  await new Promise((r) => setTimeout(r, 500));

  const spawnCardPromise = callTool("spawn_card", { kind: "sticky", callerCardId: board1BashId });
  await new Promise((r) => setTimeout(r, 500));
  check("spawn_card AINDA mostra o modal mesmo em modo autônomo", await hasModal(page), true);
  await clickModalButton(page, "Permitir");
  await spawnCardPromise;
  await new Promise((r) => setTimeout(r, 300));

  // Nenhuma tool MCP liga/desliga o modo — só board_mode existe, e é
  // read-only (confirmado pela ausência de qualquer outra tool com
  // "board"/"autonomous" no nome).
  const toolsList = await mcpCall("tools/list", {});
  const relevantTools = (toolsList.result?.tools ?? []).map((t) => t.name).filter((n) => /board|autonomous/i.test(n));
  check("a única tool relacionada a board/autonomous é board_mode (read-only)", JSON.stringify(relevantTools), JSON.stringify(["board_mode"]));

  // Isolamento entre boards — um board novo nasce false mesmo com outro
  // board autônomo, e um card daquele board novo ainda pede consentimento.
  const newSessionBtn = await centerOf(page, ".topbar-title");
  await page.click(newSessionBtn.x, newSessionBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const plusBtn = await centerOf(page, ".board-create button.primary");
  await page.click(plusBtn.x, plusBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.modal input.resume-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'Board 2 Teste');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const createBtn = await centerOf(page, ".modal-actions button.primary");
  await page.click(createBtn.x, createBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  // "Vazio" (o template default) nasce genuinamente com zero cards, de
  // propósito (achado real ao vivo, ver git blame de seedCards) — precisa
  // criar um terminal explicitamente, mesmo passo que
  // cdp-client.mjs's bootIntoFreshSession já faz pro board inicial.
  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const criarTerminalBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarTerminalBtn.x, criarTerminalBtn.y);

  const deadline = Date.now() + 8000;
  let board2BashId = null;
  while (Date.now() < deadline && !board2BashId) {
    await new Promise((r) => setTimeout(r, 300));
    const board2Cards = await toolJson("list_cards", {});
    board2BashId = board2Cards.cards.find((c) => c.id !== board1BashId && !autoSpawnedIds.includes(c.id))?.id ?? null;
  }
  check("um segundo board real foi criado, com um novo card seedado", board2BashId !== null, true);
  if (board2BashId !== null) {
    const board2Mode = await toolJson("board_mode", { target: board2BashId });
    check("um board novo nasce autonomous:false mesmo com outro board já autônomo", board2Mode.autonomous, false);

    const board2SpawnPromise = callTool("spawn_agent", { provider: "bash", callerCardId: board2BashId, reason: "board isolado" });
    await new Promise((r) => setTimeout(r, 500));
    check("um card de OUTRO board (não-autônomo) ainda pede consentimento — o modo não vaza entre boards", await hasModal(page), true);
    await clickModalButton(page, "Negar");
    await board2SpawnPromise;
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
