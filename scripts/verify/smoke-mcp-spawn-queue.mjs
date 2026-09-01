// DESIGN-BACKLOG.md item 60, peça 1 — real spawn queue with UI, reversal
// of peça 6/item 59's "structural refusal, never a queue" decision.
// Scoped to autonomous boards only (additive/opt-in, per user decision).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9567;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-spawn-queue", import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  // A call parked in the spawn queue can hold the request open long
  // enough for an SSE ": keepalive" comment line to precede the real
  // "data:" frame — always find it by content, never by the first line.
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
  await bootIntoFreshSession(page, "Board Fila Teste");
  await new Promise((r) => setTimeout(r, 500));

  const cards = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashId = cards.cards.find((c) => c.kind === "terminal").id;

  // Liga autônomo + cap=1 via UI real, mesmo fluxo do smoke de peça 2.
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[title="Editar sessão"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));
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

  // Preenche o único slot do cap.
  const first = await toolJson("spawn_agent", { provider: "claude", callerCardId: bashId, reason: "ocupa o único slot" });
  check("primeiro spawn preenche o slot único", first.ok && typeof first.cardId === "string", true);
  await new Promise((r) => setTimeout(r, 700));

  // Dispara um segundo SEM esperar (a chamada MCP fica pendurada, presa
  // na fila em vez de recusada na hora) — é exatamente isso que muda em
  // relação ao item 59: antes isso era ok:false imediato.
  const secondPromise = callTool("spawn_agent", { provider: "claude", callerCardId: bashId, reason: "excede o cap, deveria entrar na fila" });
  await new Promise((r) => setTimeout(r, 800));

  const queueInDom = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('.spawn-queue-item')].map(el => el.textContent))`),
  );
  check("o painel de fila REAL mostra 1 item enquanto o segundo spawn está pendurado", queueInDom.length, 1);
  check("...com o provider correto no texto", queueInDom[0]?.includes("claude"), true);
  check(
    "board_mode reporta queueLength:1 enquanto o item está na fila",
    (await toolJson("board_mode", { target: bashId })).queueLength,
    1,
  );

  // Mata o primeiro agente — libera o slot único, deveria disparar o da
  // fila automaticamente, sem nenhuma chamada MCP nova.
  await page.evalJs(`window.pty.kill(${JSON.stringify(first.cardId)})`);
  await new Promise((r) => setTimeout(r, 1500));

  const second = JSON.parse((await secondPromise).content[0].text);
  check("o spawn que estava na fila resolve ok:true sozinho, depois do slot liberar", second.ok && typeof second.cardId === "string", true);

  const queueAfter = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('.spawn-queue-item')].map(el => el.textContent))`),
  );
  check("o painel de fila fica vazio (some do DOM) depois do despacho", queueAfter.length, 0);
  check(
    "board_mode volta a reportar queueLength:0",
    (await toolJson("board_mode", { target: bashId })).queueLength,
    0,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
