// Pedido ao vivo (2026-09-02): "pode dar controle de cor/categoria, modo
// edição vs preview no card, e vamos por uma regra geral no mcp, se um
// agente faz modificação, spawn e etc, write, em relação a outro objeto, o
// conector conecta os dois card".
//
// Prova ao vivo, sem mock, das duas peças:
//   * `set_sticky_color`/`set_sticky_mode` — controle MCP real do que antes
//     só um clique humano fazia. `set_sticky_mode("preview")` reusa a MESMA
//     guarda de "humano editando agora" que `write_sticky` já tinha
//     (checado com um foco real, não simulado); `("edit")` nunca é
//     recusado.
//   * Regra geral de auto-conector — `write_sticky`/`set_sticky_color`/
//     `set_sticky_mode` (round-trip pelo renderer) e `send_to_card` (main
//     process puro, plumbing separado via `connector:auto`) desenham um
//     conector real entre quem chamou e o alvo, e NUNCA duplicam numa 2ª
//     ação repetida no mesmo par.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const execFileAsync = promisify(execFile);
const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-sticky-style-and-autoconnect-${CDP_PORT}`, import.meta.url).pathname;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return JSON.parse((await callTool(name, args)).content[0].text);
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
async function clickSelector(page, selector) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`selector not found: ${selector}`);
  await page.click(coords.x, coords.y);
  return coords;
}
async function stickyMode(page) {
  return JSON.parse(
    await page.evalJs(`
      JSON.stringify(document.querySelector('[data-role="sticky-textarea"]') ? 'edit' : (document.querySelector('[data-role="sticky-preview"]') ? 'preview' : null))
    `),
  );
}
/** Segundo terminal (bash), pra ter dois cards distintos pra `send_to_card`
 * — `bootIntoFreshSession` só cria o primeiro. Mesma dança de rail/popover
 * que ela já faz internamente (cdp-client.mjs não exporta um helper
 * "spawn outro terminal" separado). */
async function spawnSecondTerminal(page) {
  const terminalBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const direct = document.querySelector('.rail-btn[title="Novo terminal"]');
        if (direct) {
          const r = direct.getBoundingClientRect();
          return JSON.stringify({ type: 'direct', x: r.x + r.width/2, y: r.y + r.height/2 });
        }
        const addBtn = document.querySelector('.rail-btn[title="Adicionar card"]');
        if (addBtn) {
          const r = addBtn.getBoundingClientRect();
          return JSON.stringify({ type: 'grouped', x: r.x + r.width/2, y: r.y + r.height/2 });
        }
        return JSON.stringify(null);
      })()
    `),
  );
  if (!terminalBtn) throw new Error("rail's 'Novo terminal' or 'Adicionar card' button not found");
  await page.click(terminalBtn.x, terminalBtn.y);
  await delay(250);
  if (terminalBtn.type === "grouped") {
    await clickSelector(page, '.popover-row[data-kind="terminal"]');
    await delay(250);
  }
  await clickSelector(page, ".popover-actions button.primary");
  await delay(500);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Sticky Style + Auto-connect");
  await delay(500);

  const bashId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  const spawnPromise = callTool("spawn_card", { kind: "sticky", callerCardId: bashId, reason: "estilo + auto-conector" });
  await delay(600);
  await clickModalButton(page, "Permitir");
  await spawnPromise;
  await delay(600);
  const stickyId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "sticky").id;

  // spawn_card tinha a MESMA lacuna que este pedido corrigiu de propósito
  // (só spawn_agent registrava lineage antes) — a nota nasce já ligada
  // ao bashId que pediu, kind "spawned" (mesmo significado de sempre,
  // não o novo "modified").
  const afterSpawn = (await toolJson("list_connectors", {})).connectors;
  check("spawn_card (com callerCardId) TAMBÉM desenha lineage agora", afterSpawn.length, 1);
  check("...kind 'spawned' (mesmo mecanismo de spawn_agent, não 'modified')", afterSpawn[0].kind, "spawned");

  // --- set_sticky_color ---
  const badColor = (await callTool("set_sticky_color", { target: stickyId, color: "roxo" })).content[0].text;
  check("set_sticky_color com cor inválida é recusado pelo schema", /invalid/i.test(badColor), true);

  const colorSet = await toolJson("set_sticky_color", { target: stickyId, color: "green", callerCardId: bashId });
  check("set_sticky_color resolve ok e devolve a cor", JSON.stringify(colorSet), JSON.stringify({ ok: true, color: "green" }));
  const storedAfterColor = JSON.parse(
    await page.evalJs(`
      window.store.boards.list().then(async (boards) => {
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.id === ${JSON.stringify(stickyId)}));
      })
    `),
  );
  check("...e a cor persistida de verdade (coluna provider)", storedAfterColor.provider, "green");

  // --- regra geral de auto-conector: write_sticky ---
  const written = await toolJson("write_sticky", { target: stickyId, content: "linha 1", callerCardId: bashId });
  check("write_sticky (com callerCardId) resolve ok", written.ok, true);
  const afterWrite = (await toolJson("list_connectors", {})).connectors;
  const auto = afterWrite[0];
  const autoPair = new Set([auto.fromCardId, auto.toCardId]);
  check("...ligando exatamente bashId<->stickyId", autoPair.has(bashId) && autoPair.has(stickyId), true);
  check(
    "...NÃO duplica o conector do spawn (par já ligado, dedup por design)",
    afterWrite.length,
    1,
  );
  check("...e NÃO sobrescreve o kind 'spawned' já existente pra 'modified'", auto.kind, "spawned");

  await toolJson("write_sticky", { target: stickyId, content: "linha 2", mode: "append", callerCardId: bashId });
  check(
    "uma 2ª escrita no MESMO par não duplica o conector (idempotente)",
    (await toolJson("list_connectors", {})).connectors.length,
    1,
  );

  // --- set_sticky_mode ---
  const badMode = (await callTool("set_sticky_mode", { target: stickyId, mode: "wat" })).content[0].text;
  check("set_sticky_mode com valor inválido é recusado pelo schema", /invalid/i.test(badMode), true);

  // `mode` é persistido/controlado (card-types.ts) — `write_sticky` acima
  // só muda `content`, nunca `mode`; a nota criada vazia (mode "edit" por
  // padrão, cards/registry.ts) continua em edição mesmo depois de ganhar
  // conteúdo via MCP. `set_sticky_mode` explícito é o único jeito de mudar.
  check("write_sticky não mexe em mode — nota continua em edição de antes", await stickyMode(page), "edit");
  const modeToPreview = await toolJson("set_sticky_mode", { target: stickyId, mode: "preview", callerCardId: bashId });
  check("set_sticky_mode('preview') funciona sem humano editando", modeToPreview.ok, true);
  check("...e o DOM real muda pra preview", await stickyMode(page), "preview");
  const modeToEdit = await toolJson("set_sticky_mode", { target: stickyId, mode: "edit", callerCardId: bashId });
  check("set_sticky_mode('edit') sempre permitido, mesmo com conteúdo", modeToEdit.ok, true);
  check("...e o DOM real mostra o textarea de novo", await stickyMode(page), "edit");
  check(
    "...sem criar conector NOVO (já existia um com o mesmo par)",
    (await toolJson("list_connectors", {})).connectors.length,
    1,
  );

  await clickSelector(page, '[data-role="sticky-textarea"]');
  await delay(300);
  check(
    "clique real focou o textarea (pré-condição da guarda)",
    JSON.parse(await page.evalJs(`JSON.stringify(document.activeElement?.dataset.role === "sticky-textarea")`)),
    true,
  );
  const refusedPreview = await toolJson("set_sticky_mode", { target: stickyId, mode: "preview" });
  check("set_sticky_mode('preview') recusado com humano editando AGORA", refusedPreview.ok, false);
  check("...erro explica o motivo (mesma guarda de write_sticky)", refusedPreview.error?.includes("being edited"), true);
  check("...e o DOM continua em edição (não foi forçado pra preview)", await stickyMode(page), "edit");

  await page.evalJs(`document.activeElement.blur()`);
  await delay(300);
  const okPreview = await toolJson("set_sticky_mode", { target: stickyId, mode: "preview" });
  check("...e volta a funcionar assim que o humano sai da nota", okPreview.ok, true);
  check("...DOM real muda pra preview", await stickyMode(page), "preview");

  // --- regra geral de auto-conector: send_to_card (plumbing separado,
  // nunca passa pelo renderer por outro motivo — ver message-bus.ts) ---
  await spawnSecondTerminal(page);
  const terminalIds = (await toolJson("list_cards", {})).cards.filter((c) => c.kind === "terminal").map((c) => c.id);
  check("2º terminal real criado", terminalIds.length, 2);
  const secondId = terminalIds.find((id) => id !== bashId);

  const beforeSend = (await toolJson("list_connectors", {})).connectors.length;
  await toolJson("send_to_card", { target: secondId, text: "echo oi", callerCardId: bashId });
  await delay(400);
  const afterSend = (await toolJson("list_connectors", {})).connectors;
  check("send_to_card TAMBÉM desenha o conector automático (plumbing via push)", afterSend.length, beforeSend + 1);
  const sendAuto = afterSend.find((c) => new Set([c.fromCardId, c.toCardId]).has(secondId));
  const sendPair = new Set([sendAuto.fromCardId, sendAuto.toCardId]);
  check("...ligando bashId<->o 2º terminal", sendPair.has(bashId) && sendPair.has(secondId), true);
  check("...com kind 'modified' (send_to_card não tem lineage de spawn)", sendAuto.kind, "modified");

  await toolJson("send_to_card", { target: secondId, text: "echo oi de novo", callerCardId: bashId });
  await delay(400);
  check(
    "um 2º send_to_card no MESMO par não duplica o conector",
    (await toolJson("list_connectors", {})).connectors.length,
    beforeSend + 1,
  );

  check("nenhum modal de consentimento apareceu em nenhum passo (board content, não side-effect)", await hasModal(page), false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
