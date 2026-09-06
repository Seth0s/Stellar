// DESIGN-BACKLOG.md item 60, peça 3 — task engine with auto-dispatch,
// reading `tasks.deps_json` (NOT `connectors` — those link cards, never
// had anything to do with tasks). Scoped to autonomous boards only.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-task-engine-${CDP_PORT}`, import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Board Task Engine Teste");
  await new Promise((r) => setTimeout(r, 500));

  const cardsAtStart = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashId = cardsAtStart.cards.find((c) => c.kind === "terminal").id;
  // Só window.store expõe o board id bruto — nenhuma tool MCP devolve
  // isso diretamente (mesmo padrão já usado em smoke-mcp-autonomous-mode.mjs
  // pra achar o segundo board).
  const boardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        return JSON.stringify(boards[0].id);
      })()
    `),
  );

  // Board AINDA não autônomo — prova que marcar um dep "done" não
  // dispara nada por si só (bookkeeping puro, sem regressão do
  // comportamento de antes desta peça).
  const taskA0 = await toolJson("create_task", { prompt: "A (board não autônomo)", cardId: bashId });
  const taskB0 = await toolJson("create_task", { prompt: "B (pending), board explícito, depende de A", boardId, deps: [taskA0.taskId] });
  check("task B0 nasce 'pending' (sem cardId)", taskB0.taskId ? (await toolJson("get_task", { taskId: taskB0.taskId })).task.status : null, "pending");
  await toolJson("update_task", { taskId: taskA0.taskId, status: "done" });
  await new Promise((r) => setTimeout(r, 800));
  const cardsAfterOff = await toolJson("list_cards", {});
  check(
    "board NÃO autônomo: marcar dep 'done' não cria nenhum card novo",
    cardsAfterOff.cards.length,
    cardsAtStart.cards.length,
  );
  const taskB0After = await toolJson("get_task", { taskId: taskB0.taskId });
  check("...task B0 continua 'pending' (nunca despachada, board não autônomo)", taskB0After.task.status, "pending");

  // Liga autônomo neste board via UI real.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[data-role="edit-session"]');
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

  // Task X (roda, tem cardId) e task Y (pending, board explícito),
  // depende de X. Critério de verificação do item 60 peça 3: marcar X
  // "done" via update_task deve despachar Y sozinha, sem chamada MCP
  // nova de spawn.
  const taskX = await toolJson("create_task", { prompt: "X", cardId: bashId });
  const taskY = await toolJson("create_task", { prompt: "Y depende de X", provider: "claude", boardId, deps: [taskX.taskId] });
  const taskYBefore = await toolJson("get_task", { taskId: taskY.taskId });
  check("task Y nasce 'pending' com o board certo, sem cardId", `${taskYBefore.task.status}|${taskYBefore.task.boardId}|${taskYBefore.task.cardId}`, `pending|${boardId}|null`);

  const cardsBeforeDispatch = await toolJson("list_cards", {});
  await toolJson("update_task", { taskId: taskX.taskId, status: "done" });
  await new Promise((r) => setTimeout(r, 1500));

  const taskYAfter = await toolJson("get_task", { taskId: taskY.taskId });
  check("task Y foi auto-despachada (sai de 'pending')", taskYAfter.task.status, "running");
  check("...e ganhou um cardId real", typeof taskYAfter.task.cardId === "string", true);

  const cardsAfterDispatch = await toolJson("list_cards", {});
  check("um novo card real foi criado pelo auto-disparo", cardsAfterDispatch.cards.length, cardsBeforeDispatch.cards.length + 1);
  check("...o cardId da task bate com o card novo real", cardsAfterDispatch.cards.some((c) => c.id === taskYAfter.task.cardId), true);
  check("...sem nenhum modal (board autônomo, auto-approve)", await page.evalJs(`!document.querySelector('.modal')`), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
