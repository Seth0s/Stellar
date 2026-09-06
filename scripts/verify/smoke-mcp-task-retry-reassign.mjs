// DESIGN-BACKLOG.md item 60, peça 4 follow-up — auto-retry reassigns to
// a different provider (fallbackProviders), the multi-provider thesis
// the audit actually argued for. Item 60's first pass always retried the
// SAME provider — flagged live by a reviewing agent (card 95) as not
// really delivering on that thesis.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-task-retry-reassign-${CDP_PORT}`, import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Retry Reassign Teste");
  await new Promise((r) => setTimeout(r, 500));

  const cards = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashId = cards.cards.find((c) => c.kind === "terminal").id;

  // Liga autônomo via UI real.
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

  // Task original com provider "bash" (mesma tese cross-provider da
  // própria auditoria: bash não sabe reportar sozinho, sempre falha sem
  // report — igual smoke-mcp-tasks-failure.mjs usa). fallbackProviders
  // pede reassign pra "claude" no primeiro retry.
  const task = await toolJson("create_task", {
    prompt: "task que sempre falha no provider original",
    provider: "bash",
    cardId: bashId,
    maxRetries: 2,
    fallbackProviders: ["claude"],
  });
  check("task nasce com o provider original (bash)", task.taskId ? (await toolJson("get_task", { taskId: task.taskId })).task.provider : null, "bash");

  // Sem fallbackProviders, o retry de antes SEMPRE reusava "bash" (que
  // nunca reporta sozinho) — com fallback, o 1º retry deve reassignar
  // pra "claude" de verdade.
  await toolJson("update_task", { taskId: task.taskId, status: "failed" });
  await new Promise((r) => setTimeout(r, 1500));
  const afterRetry1 = await toolJson("get_task", { taskId: task.taskId });
  check(
    "1º retry reassigna pro provider do fallback (claude), não repete bash",
    JSON.stringify(afterRetry1.task.attemptedProviders),
    JSON.stringify(["bash", "claude"]),
  );
  check("...retryCount vira 1", afterRetry1.task.retryCount, 1);
  check("...status volta a 'running'", afterRetry1.task.status, "running");
  const cardAfterRetry1 = cards.cards.find((c) => c.id === afterRetry1.task.cardId);
  const newCards = await toolJson("list_cards", {});
  const newCardRow = newCards.cards.find((c) => c.id === afterRetry1.task.cardId);
  check("...e o card novo real É do provider 'claude'", newCardRow?.provider, "claude");
  void cardAfterRetry1;

  // Fallback list só tinha 1 provider ("claude") — já usado. Um SEGUNDO
  // retry deve voltar a repetir o último tentado (fallback esgotado),
  // não travar nem inventar um terceiro provider.
  await toolJson("update_task", { taskId: task.taskId, status: "failed" });
  await new Promise((r) => setTimeout(r, 1500));
  const afterRetry2 = await toolJson("get_task", { taskId: task.taskId });
  check(
    "2º retry (fallback esgotado): repete o provider original (bash), não trava",
    JSON.stringify(afterRetry2.task.attemptedProviders),
    JSON.stringify(["bash", "claude", "bash"]),
  );
  check("...retryCount bate o teto (2)", afterRetry2.task.retryCount, 2);

  page.close();
} finally {
  await stopApp(app);
}
finish();
