// Sticky item "close_card" (2026-09-03) — "o orquestrador não consegue
// fechar o card ou qualquer outro card, sem poder". `closeCard()`
// (App.tsx) always existed but only behind the UI's own X button — no
// MCP/acbridge path ever reached it, so a spawning agent had no way to
// tear down a card it (or anything else) created. New `close_card` tool,
// same consent shape as `open_url`/`spawn_agent`/`spawn_card`. Verifies:
// the human-consent path (modal shown, deny leaves the card alive,
// approve closes it — even a non-terminal card, sticky here, proving this
// isn't just `closeCard()`'s terminal-specific live-process gate reused
// as-is) and the autonomous auto-approve path (no modal, closes
// immediately), plus a clean error for a target that doesn't exist.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-close-card-${CDP_PORT}`, import.meta.url).pathname;

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
async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
}
async function cardExists(page, boardId, cardId) {
  return JSON.parse(
    await page.evalJs(`
      (async () => {
        const cards = await window.store.list(${JSON.stringify(boardId)});
        return JSON.stringify(cards.some((c) => c.id === ${JSON.stringify(cardId)}));
      })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Close Card Teste");
  await new Promise((r) => setTimeout(r, 500));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));

  // --- não existe: erro claro, sem consentimento nenhum de permeio ---
  const missing = await toolJson("close_card", { target: "nao-existe-123" });
  check("close_card num alvo inexistente retorna ok:false com erro claro", missing.ok === false && typeof missing.error === "string", true);

  // --- humano nega: card sobrevive ---
  // spawn_card TAMBÉM pede consentimento fora de modo autônomo — cria o
  // fixture de teste pelo mesmo round-trip real, em vez de contornar via
  // IPC direto (o que está sendo testado é close_card, não este passo,
  // mas ainda assim precisa ser um card real criado pela app de verdade).
  const stickyPromise = callTool("spawn_card", { kind: "sticky" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const stickyId = JSON.parse((await stickyPromise).content[0].text);
  check("sticky de teste criado", typeof stickyId.cardId === "string", true);
  const stickyCardId = stickyId.cardId;

  const denyPromise = callTool("close_card", { target: stickyCardId, reason: "smoke test deny" });
  await new Promise((r) => setTimeout(r, 500));
  check("modal de consentimento real aparece pro close_card", await hasModal(page), true);
  await clickModalButton(page, "Negar");
  const denyResult = JSON.parse((await denyPromise).content[0].text);
  check("close_card negado resolve ok:false", denyResult.ok, false);
  check("...e o card (sticky, não-terminal) continua existindo depois de negado", await cardExists(page, boardId, stickyCardId), true);

  // --- humano aprova: card real some ---
  const allowPromise = callTool("close_card", { target: stickyCardId });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const allowResult = JSON.parse((await allowPromise).content[0].text);
  check("close_card aprovado resolve ok:true", allowResult.ok, true);
  await new Promise((r) => setTimeout(r, 400)); // beginCloseAnimation's 180ms + margem
  check("...e o card real some do store depois de aprovado", await cardExists(page, boardId, stickyCardId), false);

  // --- modo autônomo: fecha direto, sem modal ---
  const titleBtn = await centerOf(page, ".topbar-title");
  await page.click(titleBtn.x, titleBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const pencilBtn = await centerOf(page, '.board-row.active button[data-role="edit-session"]');
  await page.click(pencilBtn.x, pencilBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const checkbox = await centerOf(page, '.autonomous-toggle-label input[type="checkbox"]');
  await page.click(checkbox.x, checkbox.y);
  await new Promise((r) => setTimeout(r, 300));
  // "Cancelar" fecha o modal sem reverter (o toggle já persistiu on-change).
  await clickModalButton(page, "Cancelar");
  await new Promise((r) => setTimeout(r, 300));

  const bashCardId = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;
  const mode = await toolJson("board_mode", { target: bashCardId });
  check("board_mode confirma modo autônomo ligado antes do 2º spawn_card", mode.autonomous, true);

  const secondSticky = await toolJson("spawn_card", { kind: "sticky", callerCardId: bashCardId });
  check("2º sticky (modo autônomo) cria sem modal, cardId real", typeof secondSticky.cardId === "string", true);
  const secondStickyId = secondSticky.cardId;
  const autoResult = await toolJson("close_card", { target: secondStickyId, callerCardId: bashCardId });
  check("close_card em board autônomo resolve ok:true sem esperar humano", autoResult.ok, true);
  check("...sem nenhum modal ter aparecido", await hasModal(page), false);
  await new Promise((r) => setTimeout(r, 400));
  check("...e o card some de verdade", await cardExists(page, boardId, secondStickyId), false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
