// DESIGN-BACKLOG.md item 57 ponto 2 — pedido ao vivo: chatbox sem botão de
// nova sessão, e sessões deveriam ser escopadas por provider (o painel
// mostrava TODAS as sessões cruzadas, de qualquer provider). Prova real:
// dois chat cards, cada um com um provider diferente e uma mensagem própria
// commitada; o painel de sessões do segundo card só deve listar a sessão
// dele mesmo, nunca a do primeiro (prova a exclusão cross-provider — a
// direção simétrica, primeiro excluindo o segundo, é a MESMA expressão de
// filtro rodando pro outro card, não vale checar via UI de novo); e o botão
// "nova sessão" deve criar um terceiro card de chat com o provider/model
// corretos (não sempre "anthropic" — a lacuna real que existia em
// `defaultCardFields`).
//
// Duas mecânicas de teste não óbvias:
// - Dois chat cards recém-criados nascem quase totalmente sobrepostos
//   (`centeredSlot` cascateia por só ~36px) — clicar em QUALQUER botão do
//   card 1 depois que o card 2 existe o traz de volta pra frente
//   (CardFrame's header pointerdown raises unconditionally), cobrindo o
//   card 2 inteiro e quebrando cliques sintéticos nele. Por isso o card 1
//   nunca é reclicado depois que o card 2 existe — todo o fluxo do card 2
//   roda em sequência ininterrupta, sempre no topo por ser sempre o último
//   clicado.
// - `SESSIONS_PANEL_OPEN_KEY` (ChatCard.tsx) é uma chave de localStorage
//   GLOBAL, compartilhada por toda instância de ChatCard, não por-card —
//   abrir o painel do card 1 já escreve "aberto" nela; o card 2, montado
//   DEPOIS, nasce com o painel JÁ aberto (herdado desse valor). Mesmo
//   padrão já usado em smoke-chat-sessions-sidebar.mjs: só clica o toggle
//   se ainda não estiver aberto.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9461;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-chat-new-session-per-provider", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "Chat New Session Teste");
  await new Promise((r) => setTimeout(r, 800));

  const chatBtn = await centerOf(page, '.rail-btn[title="Novo chatbox"]');

  // Card 1 — fica no provider default (anthropic), commita uma mensagem
  // própria pra virar uma sessão real e identificável.
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const cards = await window.store.list(boards[0].id);
      const card = cards.find((c) => c.kind === 'chat');
      await window.store.upsert({ ...card, messages_json: JSON.stringify({ messages: [{ role: 'user', content: 'mensagem-do-card-anthropic' }] }) });
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));

  // Card 1 ainda é o único no board — abrir o painel dele aqui é
  // inequívoco (sem sobreposição possível ainda).
  const panelAlreadyOpen1 = await page.evalJs(`!!document.querySelector('.chat-sessions-panel')`);
  if (!panelAlreadyOpen1) {
    const sessionsToggleBtn1 = await centerOf(page, '.chat-card button[title="Sessões de chat"]');
    await page.click(sessionsToggleBtn1.x, sessionsToggleBtn1.y);
    await new Promise((r) => setTimeout(r, 400));
  }
  const panel1Text = await page.evalJs(`document.querySelector('.chat-sessions-panel')?.textContent`);
  check("painel do card anthropic mostra a própria sessão", panel1Text?.includes("mensagem-do-card-anthropic"), true);

  // Card 2 — criado por cima do card 1 (quase totalmente sobreposto), mas
  // é o último clicado a partir daqui em diante, então fica no topo pro
  // resto do teste.
  await page.click(chatBtn.x, chatBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  const openaiPill = JSON.parse(
    await page.evalJs(`
      (() => {
        const card2 = document.querySelectorAll('.chat-card')[1];
        const btn = [...card2.querySelectorAll('.chat-provider-picker button')].find((b) => b.title.startsWith('openai'));
        const r = btn.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(openaiPill.x, openaiPill.y);
  await new Promise((r) => setTimeout(r, 300));

  // Switching to a provider with no API key configured auto-opens the key
  // form (ChatCard.tsx: `setShowKeyForm(!v)` inside the provider-change
  // effect) — real, pre-existing, intentional behavior. Close it the same
  // way a real user would (the "API key" toggle button) before interacting
  // with anything else on this card.
  const keyFormCloseBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const card2 = document.querySelectorAll('.chat-card')[1];
        const btn = card2.querySelector('button[title="API key"]');
        const r = btn.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(keyFormCloseBtn.x, keyFormCloseBtn.y);
  await new Promise((r) => setTimeout(r, 200));

  // Ground truth for openai's own default model — read from the real card
  // right after the provider switch (`commitChatProvider`'s own logic),
  // rather than hardcoding the model id here (it can change as the curated
  // list in secretsUi.ts is updated).
  const openaiDefaultModel = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const card = cards.find((c) => c.kind === 'chat' && c.provider === 'openai');
        return JSON.stringify(card.model);
      })()
    `),
  );
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const cards = await window.store.list(boards[0].id);
      const card = cards.find((c) => c.kind === 'chat' && c.provider === 'openai');
      await window.store.upsert({ ...card, messages_json: JSON.stringify({ messages: [{ role: 'user', content: 'mensagem-do-card-openai' }] }) });
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));

  check("dois chat cards abertos, um anthropic e um openai", await page.evalJs(`document.querySelectorAll('.chat-card').length`), 2);

  // `chatSessions` only refetches on the false→true transition of
  // `sessionsOpen` (ChatCard.tsx's own effect, keyed on that flag) — since
  // this card can inherit an already-open panel from the shared
  // localStorage flag (see file-header note), it may have fetched its
  // session list at MOUNT time, before the provider switch and message
  // commit above. Force a real close→open transition so the fetch that
  // backs this check is guaranteed to happen AFTER those writes, exactly
  // like a real user toggling the panel after sending a message would.
  async function sessionsToggleBtnFor(cardIndex) {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const card = document.querySelectorAll('.chat-card')[${cardIndex}];
          const btn = card.querySelector('button[title="Sessões de chat"]');
          const r = btn.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
  }
  const panelAlreadyOpen2 = await page.evalJs(
    `!!document.querySelectorAll('.chat-card')[1].querySelector('.chat-sessions-panel')`,
  );
  if (panelAlreadyOpen2) {
    const closeBtn = await sessionsToggleBtnFor(1);
    await page.click(closeBtn.x, closeBtn.y);
    await new Promise((r) => setTimeout(r, 200));
  }
  const openBtn = await sessionsToggleBtnFor(1);
  await page.click(openBtn.x, openBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const panel2Text = await page.evalJs(`document.querySelectorAll('.chat-card')[1].querySelector('.chat-sessions-panel')?.textContent`);
  check("painel do card openai mostra a própria sessão", panel2Text?.includes("mensagem-do-card-openai"), true);
  check("...e NÃO mostra a sessão do card anthropic (filtro por provider)", panel2Text?.includes("mensagem-do-card-anthropic"), false);

  // Botão "nova sessão" do card openai — deve criar um TERCEIRO card de
  // chat, com provider "openai" (não sempre "anthropic", a lacuna real de
  // `defaultCardFields`) e o model default correto pra esse provider.
  const newSessionBtn2 = JSON.parse(
    await page.evalJs(`
      (() => {
        const card2 = document.querySelectorAll('.chat-card')[1];
        const btn = card2.querySelector('.chat-sessions-new-btn');
        const r = btn.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(newSessionBtn2.x, newSessionBtn2.y);
  await new Promise((r) => setTimeout(r, 500));

  check("um terceiro chat card foi criado pelo botão de nova sessão", await page.evalJs(`document.querySelectorAll('.chat-card').length`), 3);

  const thirdCard = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const chatCards = cards.filter((c) => c.kind === 'chat');
        const third = chatCards.sort((a, b) => Number(a.id) - Number(b.id))[2];
        return JSON.stringify({ id: third.id, provider: third.provider, model: third.model, messages_json: third.messages_json });
      })()
    `),
  );
  check("o novo card nasce com o provider do card de origem (openai)", thirdCard.provider, "openai");
  check("...com o model default de openai (não o de anthropic)", thirdCard.model, openaiDefaultModel);
  check("...e uma conversa vazia (sessão nova de verdade, não clone)", JSON.parse(thirdCard.messages_json).messages.length, 0);

  page.close();
} finally {
  await stopApp(app);
}
finish();
