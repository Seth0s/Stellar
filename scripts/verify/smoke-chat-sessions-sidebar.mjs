// DESIGN-BACKLOG.md item 30 (parte 2) + item 38 (correção de escopo) —
// usuário pediu: "a barra lateral seria pra isso, ver todas as sessões e
// ao clique voltar a conversa" — e depois corrigiu: a barra é DENTRO do
// chatbox (painel expansível, item 38), não um popover na régua do canvas
// (implementação original do item 30, errada). Fechar um ChatCard hoje faz
// DELETE de verdade no banco (confirmado lendo o código antes deste item)
// — sem arquivar em vez de deletar, uma barra lateral não teria o que
// mostrar. Prova real, sem mock de UI: mensagem real commitada, card
// fechado, confirmado que a LINHA sobrevive no banco (archived_at setado,
// não DELETE), aparece no painel (aberto de OUTRO chatbox, já que o card
// original some do board) com o texto real da conversa, reabre no board
// certo (incluindo cross-board) e desarquiva de verdade — cobre o ciclo
// completo: arquivar -> listar -> reabrir -> desarquivar.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9457;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-chat-sessions-sidebar", import.meta.url).pathname;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
}
async function clickRowContaining(page, selector, text) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  if (!coords) throw new Error(`row containing "${text}" not found via ${selector}`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Sessions Sidebar Teste");
  await new Promise((r) => setTimeout(r, 800));

  const chatBtn = await centerOf(page, '.rail-btn[title="Novo chatbox"]');
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  const chatCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'chat').id);
      })()
    `),
  );

  // Commit a real message directly via the store (same shape App.tsx's
  // commitChatMessages writes) — no need for a real API key/mock server
  // here, this item is about persistence/UI, not the send path itself
  // (already covered by smoke-chat.mjs and smoke-anthropic-caching.mjs).
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const cards = await window.store.list(boards[0].id);
      const card = cards.find((c) => c.kind === 'chat');
      await window.store.upsert({ ...card, messages_json: JSON.stringify({ messages: [{ role: 'user', content: 'mensagem única de teste da sidebar' }] }) });
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));

  // Close the card — item 30's real fix: archive, not delete. Simplest
  // reliable close: the chat card's own close button is the last one in
  // .card-head-actions (same convention as BrowserCard).
  const chatCloseBtn = JSON.parse(
    await page.evalJs(`
      (() => { const b = [...document.querySelectorAll('.chat-card .card-head-actions button')].pop(); if (!b) return JSON.stringify(null); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
  await page.click(chatCloseBtn.x, chatCloseBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  check("o card de chat some do board depois de fechado", await page.evalJs(`document.querySelectorAll('.chat-card').length`), 0);

  const rowAfterClose = await page.evalJs(`
    (async () => {
      const row = await window.store.listChatSessions();
      return JSON.stringify(row.find((r) => r.id === ${JSON.stringify(chatCardId)}));
    })()
  `);
  const parsedRow = JSON.parse(rowAfterClose);
  check("a LINHA sobrevive no banco depois de fechar (arquivada, não DELETE de verdade)", parsedRow !== undefined, true);
  check("...com archived_at setado de verdade (não null)", typeof parsedRow?.archived_at === "number", true);
  check("...e o texto real da mensagem sobrevive junto", parsedRow?.messages_json?.includes("mensagem única de teste da sidebar"), true);

  // item 38 — o painel de sessões vive DENTRO de um chatbox agora, não
  // mais na régua. Com o único chatbox arquivado, o board não tem card
  // nenhum pra abrir o painel a partir dele — abre um chatbox NOVO
  // ("Novo chatbox") e usa o painel DELE pra ver/reabrir a sessão
  // arquivada, exatamente o fluxo real (é assim que dá pra voltar a uma
  // conversa fechada: por um chatbox qualquer, não necessariamente o
  // mesmo que foi fechado).
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  check("um segundo chatbox (novo, vazio) foi criado", await page.evalJs(`document.querySelectorAll('.chat-card').length`), 1);

  const sessionsToggleBtn = await centerOf(page, '.chat-card .card-head-actions button[title="Sessões de chat"]');
  await page.click(sessionsToggleBtn.x, sessionsToggleBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const panelText = await page.evalJs(`document.querySelector('.chat-sessions-panel')?.textContent`);
  check("o painel mostra o texto real da conversa arquivada", panelText?.includes("mensagem única de teste da sidebar"), true);
  check("...e o badge 'arquivada'", panelText?.includes("arquivada"), true);

  // Clica na sessão — reabre no board (mesmo board aqui), desarquiva.
  await clickRowContaining(page, ".chat-session-row", "mensagem única de teste da sidebar");
  await new Promise((r) => setTimeout(r, 600));

  check(
    "o card de chat arquivado REAPARECE no board depois de clicar na sessão (agora 2: o novo + o reaberto)",
    await page.evalJs(`document.querySelectorAll('.chat-card').length`),
    2,
  );
  const rowAfterReopen = await page.evalJs(`
    (async () => {
      const row = await window.store.listChatSessions();
      return JSON.stringify(row.find((r) => r.id === ${JSON.stringify(chatCardId)}));
    })()
  `);
  check("...e archived_at volta pra null (desarquivado de verdade, não só visual)", JSON.parse(rowAfterReopen)?.archived_at, null);

  // Cross-board case: close the REOPENED card (the one with the real
  // message — not the empty second chatbox), create a SECOND board,
  // confirm the panel (opened from a fresh chatbox there) still lists it
  // (global, not board-scoped) and clicking switches board AND brings the
  // card back — a genuinely different code path than same-board
  // (openChatSession, App.tsx: the same-board branch was found broken
  // during development — reappearing required inserting the row into
  // React state directly, since neither `switchBoard` nor `loadBoard` fit
  // that case; this second board exercises the OTHER branch, which relies
  // on a real `switchBoard`).
  const reopenedCloseBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const card = [...document.querySelectorAll('.chat-card')].find((c) => c.textContent.includes('mensagem única de teste da sidebar'));
        const b = [...card.querySelectorAll('.card-head-actions button')].pop();
        const r = b.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(reopenedCloseBtn.x, reopenedCloseBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  const homeBtn = await centerOf(page, ".topbar-home, [title='Home']");
  await page.click(homeBtn.x, homeBtn.y);
  await new Promise((r) => setTimeout(r, 600));
  const newSessionBtn = JSON.parse(
    await page.evalJs(`
      (() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('nova sess')); if (!b) return JSON.stringify(null); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
  await page.click(newSessionBtn.x, newSessionBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.modal input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'Segundo Board');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const createBtn = JSON.parse(
    await page.evalJs(`
      (() => { const b = [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === 'Criar'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()
    `),
  );
  await page.click(createBtn.x, createBtn.y);
  await new Promise((r) => setTimeout(r, 800));

  check("board novo genuinamente não tem o chat card (board diferente)", await page.evalJs(`document.querySelectorAll('.chat-card').length`), 0);

  // Abre um chatbox NOVO aqui (board 2) e o painel DELE — só assim dá pra
  // ver a sessão que ficou pra trás no board 1. O estado aberto/fechado do
  // painel é persistido (mesmo espírito do CentralByte — abrir uma vez
  // deixa aberto dali em diante) e essa MESMA persistência já foi setada
  // pra "aberto" pelo primeiro chatbox lá em cima — o painel deste novo
  // chatbox já nasce aberto, então só clica o toggle se ele NÃO estiver.
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  const panelAlreadyOpen = await page.evalJs(`!!document.querySelector('.chat-sessions-panel')`);
  if (!panelAlreadyOpen) {
    const sessionsToggleBtn2 = await centerOf(page, '.chat-card .card-head-actions button[title="Sessões de chat"]');
    await page.click(sessionsToggleBtn2.x, sessionsToggleBtn2.y);
    await new Promise((r) => setTimeout(r, 400));
  }
  const panelTextFromOtherBoard = await page.evalJs(`document.querySelector('.chat-sessions-panel')?.textContent`);
  check("o painel lista a sessão de OUTRO board também (global, não por board)", panelTextFromOtherBoard?.includes("mensagem única de teste da sidebar"), true);

  await clickRowContaining(page, ".chat-session-row", "mensagem única de teste da sidebar");
  await new Promise((r) => setTimeout(r, 1000));
  // A sessão pertence ao board 1 — clicar troca DE VOLTA pro board 1
  // (openChatSession's cross-board branch), que ainda tem o chatbox vazio
  // #2 deixado por lá + o card recém-reaberto = 2.
  check("clicar troca de board E traz o card de volta (cross-board, não só same-board)", await page.evalJs(`document.querySelectorAll('.chat-card').length`), 2);

  page.close();
} finally {
  await stopApp(app);
}
finish();
