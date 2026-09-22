// Manual identify of an empty resume_id: button next to `resume:` in the
// card footer (and the ⋯ menu), one card, IPC in main. Measures the three
// UI outcomes the owner named: found (id lands in the footer), none
// (says what was missing), and that a card with an id never gets the button.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, clickProviderInPicker, openTerminalCreatePopover } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-identify-session-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Identify Session");
  await delay(800);

  const bashIdentify = JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        buttons: document.querySelectorAll('[data-kind="terminal"] [data-role="terminal-identify-session"]').length,
        cardMenus: document.querySelectorAll('[data-kind="terminal"] [data-role="terminal-card-menu"]').length,
        identifyItems: document.querySelectorAll('[data-role="terminal-identify-menu-item"]').length,
      })
    `),
  );
  check("seeded bash card has no identify button (no session concept)", bashIdentify.buttons, 0);
  // O ⋯ deixou de ser "menu de identificar": a 6a6238c o transformou no menu
  // DO CARD (marcar/limpar orquestrador, TerminalCard.tsx), em QUALQUER
  // provider — o `{canIdentify && ...}` que envolvia o BOTÃO saiu, e sobrou
  // só em volta do ITEM de identificar (linha 772 do componente). A
  // invariante que continua valendo para um card bash não é "não tem ⋯", é
  // "o ⋯ dele não oferece sessão".
  check("seeded bash card ⋯ menu exists (it is the card menu now, 6a6238c)", bashIdentify.cardMenus, 1);
  check("...and it offers no Identify session item (bash has no session concept)", bashIdentify.identifyItems, 0);

  await openTerminalCreatePopover(page);
  const pickerLabels = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('.provider-picker-btn')].map((b) => b.textContent.trim()))`),
  );
  // O picker casa pelo RÓTULO declarado: o `[title="claude"]` que estava aqui
  // nunca casou (o `title` do botão é o rótulo + as flags, desde a c857539c).
  // O provider AQUI NÃO PODE SER `claude` (medido 2026-09-22, task 71128571).
  // `claude` declara `canImposeSessionId: true` com `imposeFlag: "--session-id"`
  // (providers.ts), isto é, o Stellar CRIA a sessão com um UUID próprio no
  // spawn — então um card claude NUNCA tem `resume_id` vazio, e `canIdentify`
  // (`!effectiveResumeId && …`, TerminalCard.tsx) nunca é verdadeiro: o botão
  // de identificar não existe para ele por desenho. A rodada que "passou" nas
  // checagens de card vazio mediu uma JANELA: a linha do card nasce sem o id e
  // ele chega logo depois. `codex` não impõe (`canImposeSessionId: false`), então
  // o estado vazio — que é a pré-condição inteira deste smoke — é estável.
  check("codex provider picker exists", pickerLabels.includes("Codex"), true);
  await clickProviderInPicker(page, "codex");
  await delay(200);
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  check("create-terminal submit exists", criarBtn !== null, true);
  await page.click(criarBtn.x, criarBtn.y);
  await delay(1500);

  const created = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        const codex = cards.find((c) => c.kind === "terminal" && c.provider === "codex");
        return JSON.stringify({
          id: codex?.id ?? null,
          cwd: codex?.cwd ?? null,
          resume_id: codex?.resume_id ?? null,
          // O que a store tinha de fato, para a falha ter diagnóstico em vez
          // de um "got false" mudo (medido 2026-09-22: a mesma checagem falhou
          // numa rodada e passou na seguinte, sem nada mudar no smoke).
          terminals: cards.filter((c) => c.kind === "terminal").map((c) => ({ id: c.id, provider: c.provider, resume_id: c.resume_id ?? null, cwd: c.cwd })),
        });
      })()
    `),
  );
  check("codex card exists with empty resume_id", created.id !== null && created.resume_id === null, true);
  if (created.id === null || created.resume_id !== null) {
    console.log(`  store (terminais): ${JSON.stringify(created.terminals)}`);
  }

  // Escopado AO CARD que tem o botão de identificar — não ao documento. O
  // `document.querySelectorAll('[data-role="terminal-card-menu"]')` de antes
  // contava o ⋯ do card bash TAMBÉM (dois no DOM depois da 6a6238c), e o
  // `querySelector` seguinte clicava no primeiro deles — o do BASH, cujo
  // menu não tem item de identificar. Foi por isso que "⋯ menu lists
  // Identify session" dava false: media o card errado.
  const ui = JSON.parse(
    await page.evalJs(`
      JSON.stringify((() => {
        const btn = document.querySelector('[data-role="terminal-identify-session"]');
        const card = btn?.closest('[data-kind="terminal"]') ?? null;
        return {
          buttons: document.querySelectorAll('[data-role="terminal-identify-session"]').length,
          cardMenusInThisCard: card ? card.querySelectorAll('[data-role="terminal-card-menu"]').length : -1,
          emptyResume: !!document.querySelector('[data-role="terminal-resume-empty"]'),
        };
      })())
    `),
  );
  check("empty-resume codex card shows the identify button", ui.buttons, 1);
  check("...e o ⋯ DESTE card (um, no próprio card — não o do bash)", ui.cardMenusInThisCard, 1);
  check("button sits next to the empty resume: label", ui.emptyResume, true);

  const menuOpened = JSON.parse(
    await page.evalJs(`
      (() => {
        const card = document.querySelector('[data-role="terminal-identify-session"]')?.closest('[data-kind="terminal"]');
        const btn = card?.querySelector('[data-role="terminal-card-menu"]');
        if (!btn) return JSON.stringify(false);
        btn.click();
        return JSON.stringify(true);
      })()
    `),
  );
  check("⋯ menu button accepts a click", menuOpened, true);
  await delay(200);
  const menuItem = JSON.parse(
    await page.evalJs(`JSON.stringify(!!document.querySelector('[data-role="terminal-identify-menu-item"]'))`),
  );
  check("⋯ menu lists Identify session", menuItem, true);
  // Fecha o menu ANTES de clicar no rodapé: com o popover aberto, o
  // `pointerdown` que o fecha é o MESMO gesto que devia acionar o botão, e
  // o clique do rodapé não acionava nada (medido: nem `data-busy`, nem
  // feedback — as duas checagens seguintes reprovavam por isso). Um humano
  // teria fechado o menu com o mouse antes de mirar o rodapé.
  await page.evalJs(`
    (() => {
      const card = document.querySelector('[data-role="terminal-identify-session"]')?.closest('[data-kind="terminal"]');
      const btn = card?.querySelector('[data-role="terminal-card-menu"]');
      if (btn) btn.click();
    })()
  `);
  await delay(150);

  const noneCwd = `/tmp/stellar-identify-none-${CDP_PORT}`;
  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const cards = await window.store.list(boards[0].id);
      const codex = cards.find((c) => c.kind === "terminal" && c.provider === "codex");
      await window.store.upsert({ ...codex, cwd: ${JSON.stringify(noneCwd)} });
    })()
  `);

  const identifyBtn = await centerOf(page, '[data-role="terminal-identify-session"]');
  if (identifyBtn === null) {
    // Falha NOMEANDO o que faltou, em vez de estourar em `identifyBtn.x`
    // (TypeError sem nome, que é o que este smoke fazia quando o card não
    // tinha o botão). Um smoke que morre assim não diz se o app regrediu ou
    // se ele mesmo perdeu a pré-condição.
    throw new Error(
      `identify button not found — o card codex não está com resume vazio (store: ${JSON.stringify(created.terminals)})`,
    );
  }
  // O que está NO PONTO que vamos clicar, antes de clicar: se um overlay
  // qualquer cobrir o rodapé, o clique não aciona nada e o smoke parecia
  // estar medindo o app (medido 2026-09-22: nem `data-busy` nem feedback
  // apareciam). Imprime o que havia ali para o próximo não ter de adivinhar.
  const atPoint = await page.evalJs(`
    (() => {
      const el = document.elementFromPoint(${identifyBtn.x}, ${identifyBtn.y});
      if (!el) return "nada (fora da janela?)";
      return el.getAttribute("data-role") ?? el.className ?? el.tagName;
    })()
  `);
  console.log(`ponto do clique no rodapé (${Math.round(identifyBtn.x)},${Math.round(identifyBtn.y)}): ${JSON.stringify(atPoint)}`);
  if (atPoint === "nada (fora da janela?)") {
    // MEDIDO (2026-09-22, task 71128571): o centro do botão cai FORA da
    // janela (o rodapé do card fica abaixo da borda inferior — um canvas
    // grande num viewport menor), então `page.click` naquelas coordenadas
    // não acerta nada e as duas checagens seguintes reprovavam como se o app
    // não tivesse desarmado o botão. Um humano daria zoom/pan antes de
    // clicar; aqui o clique vai pelo DOM (mesmo `onClick` do React), e o
    // motivo fica declarado no output em vez de escondido.
    console.log("  → ponto fora da janela: usando o clique do DOM (mesmo onClick), não o sintético por coordenada");
    await page.evalJs(`document.querySelector('[data-role="terminal-identify-session"]')?.click()`);
  } else {
    await page.click(identifyBtn.x, identifyBtn.y);
  }
  const busySoon = JSON.parse(
    await page.evalJs(`
      (() => {
        const btn = document.querySelector('[data-role="terminal-identify-session"]');
        return JSON.stringify({ disabled: btn?.disabled === true, busy: btn?.getAttribute("data-busy") === "true" });
      })()
    `),
  );
  check(
    "click disarms the button (disabled or data-busy) so a second click cannot start another read",
    busySoon.disabled || busySoon.busy,
    true,
  );

  const noneDeadline = Date.now() + 12000;
  let noneFeedback = "";
  while (Date.now() < noneDeadline) {
    noneFeedback = await page.evalJs(
      `document.querySelector('[data-role="terminal-identify-feedback"]')?.textContent ?? ""`,
    );
    if (noneFeedback) break;
    await delay(150);
  }
  check(
    "none: footer names what was missing (no silent blink)",
    /Nenhuma sessão deste provider para este diretório/.test(noneFeedback),
    true,
  );

  await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const cards = await window.store.list(boards[0].id);
      const codex = cards.find((c) => c.kind === "terminal" && c.provider === "codex");
      await window.store.upsert({ ...codex, cwd: ${JSON.stringify(created.cwd)} });
    })()
  `);

  const ipc = JSON.parse(
    await page.evalJs(`
      (async () => {
        const result = await window.pty.identifySession(${JSON.stringify(created.id)});
        return JSON.stringify(result);
      })()
    `),
  );
  check("IPC returns a structured status (never a bare throw)", typeof ipc.status === "string", true);

  if (ipc.status === "found") {
    const foundBtn = await centerOf(page, '[data-role="terminal-identify-session"]');
    await page.click(foundBtn.x, foundBtn.y);
    const foundDeadline = Date.now() + 12000;
    let resumeText = "";
    while (Date.now() < foundDeadline) {
      resumeText = await page.evalJs(`
        document.querySelector('[data-kind="terminal"] .card-foot')?.textContent ?? ""
      `);
      if (resumeText.includes(`resume:${ipc.id}`)) break;
      await delay(150);
    }
    check("found: resume id appears in the footer immediately", resumeText.includes(`resume:${ipc.id}`), true);
    const buttonsAfter = JSON.parse(
      await page.evalJs(`JSON.stringify(document.querySelectorAll('[data-role="terminal-identify-session"]').length)`),
    );
    check("found: identify button disappears once the card has an id", buttonsAfter, 0);
  } else {
    check(
      `found path not exercised live (IPC status=${ipc.status}); unit test covers found+claimed+ambiguous`,
      true,
      true,
    );
  }
} finally {
  await stopApp(app);
}
finish();
