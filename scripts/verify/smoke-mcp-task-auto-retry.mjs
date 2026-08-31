// DESIGN-BACKLOG.md item 60, peça 4 — real auto-retry, scoped to
// autonomous boards only. Two failure paths: explicit
// update_task({status:"failed"}), and a card exiting with a nonzero code
// having never called `report` at all.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9589;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-task-auto-retry", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Board Auto-Retry Teste");
  await new Promise((r) => setTimeout(r, 500));

  const cardsAtStart = await toolJson("list_cards", {});
  const bashId = cardsAtStart.cards[0].id;
  const boardId = JSON.parse(
    await page.evalJs(`(async () => { const boards = await window.store.boards.list(); return JSON.stringify(boards[0].id); })()`),
  );

  // Board NÃO autônomo — marcar failed não deve auto-retentar (bookkeeping puro).
  const taskOff = await toolJson("create_task", { prompt: "falha, board não autônomo", cardId: bashId, provider: "claude" });
  await toolJson("update_task", { taskId: taskOff.taskId, status: "failed" });
  await new Promise((r) => setTimeout(r, 800));
  const taskOffAfter = await toolJson("get_task", { taskId: taskOff.taskId });
  check("board NÃO autônomo: task falha continua 'failed', sem retry automático", taskOffAfter.task.status, "failed");
  check("...retryCount continua 0 (nenhum auto-retry disparou)", taskOffAfter.task.retryCount, 0);

  // Liga autônomo.
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

  // Caminho 1: update_task({status:"failed"}) explícito — deve auto-retentar.
  const cardsBefore1 = await toolJson("list_cards", {});
  const task1 = await toolJson("create_task", { prompt: "falha explícita, board autônomo", cardId: bashId, provider: "claude", maxRetries: 2 });
  await toolJson("update_task", { taskId: task1.taskId, status: "failed" });
  await new Promise((r) => setTimeout(r, 1500));
  const task1After = await toolJson("get_task", { taskId: task1.taskId });
  check("board autônomo: task falha explícita auto-retenta (retryCount vira 1)", task1After.task.retryCount, 1);
  check("...status volta a 'running' (retry despachou de novo)", task1After.task.status, "running");
  const cardsAfter1 = await toolJson("list_cards", {});
  check("...um novo card real foi criado pelo retry", cardsAfter1.cards.length, cardsBefore1.cards.length + 1);
  check("...sem nenhum modal (autônomo, auto-approve)", await page.evalJs(`!document.querySelector('.modal')`), true);

  // Caminho 2: processo sai com código != 0 sem NUNCA chamar report — motor
  // detecta sozinho via resolveCardExit e auto-retenta também.
  const cardsBefore2 = await toolJson("list_cards", {});
  const spawnResult2 = await toolJson("spawn_agent", { provider: "claude", callerCardId: bashId, reason: "vai morrer sem reportar" });
  check("spawn real pro caminho 2 resolve ok:true", spawnResult2.ok, true);
  const task2 = await toolJson("create_task", { prompt: "vai sair sem reportar", cardId: spawnResult2.cardId, provider: "claude", maxRetries: 2 });
  await page.evalJs(`window.pty.kill(${JSON.stringify(spawnResult2.cardId)})`);
  await new Promise((r) => setTimeout(r, 1500));
  const task2After = await toolJson("get_task", { taskId: task2.taskId });
  check("saída silenciosa (sem report) é detectada e auto-retentada (retryCount vira 1)", task2After.task.retryCount, 1);
  check("...status volta a 'running'", task2After.task.status, "running");
  const cardsAfter2 = await toolJson("list_cards", {});
  // +2 em relação ao "antes": +1 do spawn_agent original (que depois
  // morreu) e +1 do card novo que o auto-retry criou por cima.
  check("...um novo card real foi criado pelo retry (não o que morreu)", cardsAfter2.cards.length, cardsBefore2.cards.length + 2);

  // Teto de retry — força falhar de novo até bater maxRetries:2 e confirma
  // que PARA (fica failed de vez, sem loop infinito).
  await toolJson("update_task", { taskId: task1.taskId, status: "failed" });
  await new Promise((r) => setTimeout(r, 1500));
  const task1AfterRetry2 = await toolJson("get_task", { taskId: task1.taskId });
  check("segunda falha: retryCount vira 2 (bate o teto)", task1AfterRetry2.task.retryCount, 2);
  await toolJson("update_task", { taskId: task1.taskId, status: "failed" });
  await new Promise((r) => setTimeout(r, 1000));
  const task1AfterCap = await toolJson("get_task", { taskId: task1.taskId });
  check("terceira falha: PARA de retentar (teto batido) — fica 'failed' de vez", task1AfterCap.task.status, "failed");
  check("...retryCount NÃO passa do teto (continua 2, não incrementou de novo)", task1AfterCap.task.retryCount, 2);

  page.close();
} finally {
  await stopApp(app);
}
finish();
