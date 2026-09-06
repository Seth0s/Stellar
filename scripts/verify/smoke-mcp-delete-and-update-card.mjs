// Pendentes #188 ("delete_card"/"update_card_content") — close_card and
// write_sticky only ever look at the CURRENTLY LOADED board's live cards
// (callbacks.listCards()); a card on any other board only exists as a DB
// row, invisible to both. `delete_card`/`update_card_content` reach any
// board: on the loaded one they delegate straight to close_card/
// write_sticky (same behavior, verified via the same consent modal); on
// any other board — no live UI there to ever ask a human — they require
// that board's OWN autonomous flag, same contract spawn_card/open_url use.
//
// Cross-board cards are seeded directly via `window.store.upsert` (the
// same IPC the renderer itself uses to persist a card) rather than by
// switching boards in the UI — this app kills a board's live PTYs on
// switch (see AGENTS.md), so a real terminal card wouldn't survive the
// switch anyway, and a sticky's content is already just a DB row
// (App.tsx's `toRow` repurposes `cwd` for it, no schema of its own).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-delete-update-card-${CDP_PORT}`, import.meta.url).pathname;
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
  return JSON.parse(await page.evalJs(`JSON.stringify(!!document.querySelector('.modal-root'))`));
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
async function seedBoard(page, boardId) {
  await page.evalJs(`
    window.store.boards.upsert({
      id: ${JSON.stringify(boardId)}, name: "Off-board Test", project: "", cwd: "",
      created_at: Date.now(), updated_at: Date.now(), last_accessed_at: null,
      autonomous: false, concurrency_cap: null,
    })
  `);
}
async function seedCard(page, { id, boardId, kind, content }) {
  await page.evalJs(`
    window.store.upsert({
      id: ${JSON.stringify(id)}, board_id: ${JSON.stringify(boardId)}, kind: ${JSON.stringify(kind)},
      provider: "", cwd: ${JSON.stringify(content ?? "")}, x: 0, y: 0, w: 860, h: 660,
      resume_id: null, model: "edit", system_prompt: null, group_id: null, label: null,
      updated_at: Date.now(), messages_json: null, archived_at: null,
    })
  `);
}
async function rowsForBoard(page, boardId) {
  return JSON.parse(await page.evalJs(`window.store.list(${JSON.stringify(boardId)}).then((r) => JSON.stringify(r))`));
}
async function setAutonomous(page, boardId, value) {
  await page.evalJs(`window.store.boards.setAutonomous(${JSON.stringify(boardId)}, ${value})`);
}
async function stickyRect(page, cardId) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('textarea[data-role="sticky-textarea"][data-card-id=${JSON.stringify(cardId)}]');
        return JSON.stringify(el ? el.value : null);
      })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Delete/Update Card Smoke");
  await delay(500);

  const bashId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  // --- alvos que não existem em lugar nenhum ---
  const missingDelete = await toolJson("delete_card", { target: "nao-existe-777", callerCardId: bashId });
  check("delete_card num alvo totalmente inexistente retorna erro claro", missingDelete.ok === false && /no card with id/.test(missingDelete.error ?? ""), true);
  const missingUpdate = await toolJson("update_card_content", { target: "nao-existe-777", content: "x", callerCardId: bashId });
  check("update_card_content num alvo totalmente inexistente retorna erro claro", missingUpdate.ok === false && /no card with id/.test(missingUpdate.error ?? ""), true);

  // --- board OFF (não carregado, não autônomo): sticky de teste seedada direto no DB ---
  const OFF_BOARD = "offboard-test-1";
  await seedBoard(page, OFF_BOARD);
  await seedCard(page, { id: "offboard-sticky-1", boardId: OFF_BOARD, kind: "sticky", content: "conteúdo original" });
  await seedCard(page, { id: "offboard-sticky-2", boardId: OFF_BOARD, kind: "sticky", content: "vai ser deletado" });
  await seedCard(page, { id: "offboard-files-1", boardId: OFF_BOARD, kind: "files", content: "" });

  const refusedUpdate = await toolJson("update_card_content", { target: "offboard-sticky-1", content: "novo", callerCardId: bashId });
  check("update_card_content num board não-carregado e não-autônomo é recusado", refusedUpdate.ok === false && /isn't currently loaded/.test(refusedUpdate.error ?? ""), true);
  const refusedDelete = await toolJson("delete_card", { target: "offboard-sticky-2", callerCardId: bashId });
  check("delete_card num board não-carregado e não-autônomo é recusado", refusedDelete.ok === false && /isn't currently loaded/.test(refusedDelete.error ?? ""), true);
  check("...e nenhuma das duas notas seedadas foi tocada", (await rowsForBoard(page, OFF_BOARD)).length, 3);

  const wrongKind = await toolJson("update_card_content", { target: "offboard-files-1", content: "x", callerCardId: bashId });
  check("update_card_content num card não-sticky explica o kind (mesmo board não-carregado)", wrongKind.ok === false && /is a files card/.test(wrongKind.error ?? ""), true);

  // --- liga autônomo NAQUELE board (não no board carregado) ---
  await setAutonomous(page, OFF_BOARD, true);

  const okUpdate = await toolJson("update_card_content", { target: "offboard-sticky-1", content: "novo conteúdo", callerCardId: bashId });
  check("update_card_content funciona depois de autônomo ligado NAQUELE board", JSON.stringify(okUpdate), JSON.stringify({ ok: true, content: "novo conteúdo" }));
  const rowAfterUpdate = (await rowsForBoard(page, OFF_BOARD)).find((r) => r.id === "offboard-sticky-1");
  check("...e a linha real no banco reflete o novo conteúdo", rowAfterUpdate.cwd, "novo conteúdo");

  const okAppend = await toolJson("update_card_content", { target: "offboard-sticky-1", content: " + mais", mode: "append", callerCardId: bashId });
  check("mode:append funciona igual no caminho cross-board", okAppend.content, "novo conteúdo + mais");

  const okDelete = await toolJson("delete_card", { target: "offboard-sticky-2", callerCardId: bashId });
  check("delete_card funciona depois de autônomo ligado NAQUELE board", okDelete.ok, true);
  check("...e a linha real some do banco", (await rowsForBoard(page, OFF_BOARD)).some((r) => r.id === "offboard-sticky-2"), false);
  check("...sem afetar a outra nota do mesmo board", (await rowsForBoard(page, OFF_BOARD)).some((r) => r.id === "offboard-sticky-1"), true);

  // --- board CARREGADO: delega de verdade pra close_card/write_sticky, não uma 2ª implementação ---
  const liveSticky = await toolJson("spawn_card", { kind: "sticky", callerCardId: bashId });
  await delay(400);

  const updatePromise = callTool("update_card_content", { target: liveSticky.cardId, content: "escrito via update_card_content", callerCardId: bashId });
  const updateResult = JSON.parse((await updatePromise).content[0].text);
  check("update_card_content num sticky do board carregado resolve ok (delega pra write_sticky)", updateResult.content, "escrito via update_card_content");
  check("...e o textarea REAL na tela mostra o texto (não só a resposta da tool)", await stickyRect(page, liveSticky.cardId), "escrito via update_card_content");

  const deletePromise = callTool("delete_card", { target: liveSticky.cardId, callerCardId: bashId });
  await delay(500);
  check("delete_card num card do board carregado mostra o MESMO modal de close_card (delegação de verdade)", await hasModal(page), true);
  await clickModalButton(page, "Permitir");
  const deleteResult = JSON.parse((await deletePromise).content[0].text);
  check("...e resolve ok depois de Permitir", deleteResult.ok, true);
  await delay(400);
  check("...e o card real some do board carregado", JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('textarea[data-role="sticky-textarea"][data-card-id=${JSON.stringify(liveSticky.cardId)}]') === null)`)), true);
} finally {
  finish();
  await stopApp(app);
}
