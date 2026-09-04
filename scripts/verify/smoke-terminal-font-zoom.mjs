// DESIGN-BACKLOG.md item 57 ponto 10 — this test went through several
// revisions chasing a "keep apparent text size constant across board
// zoom" feature (fontSize compensating the board's zoom inversely).
// That whole mechanism is REMOVED now (achado ao vivo, 2026-09-04):
// asked directly by the user after the WebGL-blur fix ("Então pode
// remover essa funcionalidade, eu quero apenas esse efeito no resize")
// — board zoom is purely OPTICAL for a terminal card, same as every
// other card kind (Trilha B); `fontSize` is fixed at `BASE_FONT_SIZE`
// for the card's whole lifetime and never reacts to board zoom at all.
// This also fully sidesteps the original bug this file used to guard
// against (a CLI's statusline wrapping into giant text at low board
// zoom) — if nothing about the terminal's real rendering ever changes
// with board zoom, it can't wrap from a zoom change either.
//
// The only thing that still changes fontSize/cols/rows for real is a
// manual card RESIZE (drag the card's edge) — covered separately by
// `smoke-terminal-resize-fluidity.mjs`, untouched by this change.
//
// Sinal usado: `terminal-registry.ts`'s `getTerminalFontSize(cardId)`,
// exposto em `window.__getTerminalFontSize` — lê `term.options.fontSize`
// direto da instância viva do xterm.js.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9468;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-font-zoom", import.meta.url).pathname;

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

async function fontSizeFor(page, cardId, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await page.evalJs(`window.__getTerminalFontSize(${JSON.stringify(cardId)})`);
    if (result !== null || Date.now() > deadline) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Terminal Font Zoom Teste");
  await new Promise((r) => setTimeout(r, 800));

  // O bash padrão semeado por bootIntoFreshSession já serve de card sob
  // teste. Cria um segundo terminal, provider "claude" (instalado de
  // verdade nesta máquina), como comparação.
  const terminalBtn = await centerOf(page, '.rail-btn[title="Novo terminal"]');
  await page.click(terminalBtn.x, terminalBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const claudeBtnCoords = await centerOf(page, '.provider-picker-btn[title="claude"]');
  if (!claudeBtnCoords) throw new Error("botão de provider 'claude' não encontrado no popover de criação de terminal");
  await page.click(claudeBtnCoords.x, claudeBtnCoords.y);
  await new Promise((r) => setTimeout(r, 200));
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarBtn.x, criarBtn.y);
  await new Promise((r) => setTimeout(r, 1500));

  const ids = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify({
          bashId: cards.find((c) => c.kind === 'terminal' && c.provider === 'bash').id,
          claudeId: cards.find((c) => c.kind === 'terminal' && c.provider === 'claude').id,
        });
      })()
    `),
  );
  check("card bash e card claude ambos existem", ids.bashId !== undefined && ids.claudeId !== undefined, true);

  const bashBefore = await fontSizeFor(page, ids.bashId);
  const claudeBefore = await fontSizeFor(page, ids.claudeId);
  check("consegue ler fontSize do card bash", bashBefore !== null, true);
  check("consegue ler fontSize do card claude", claudeBefore !== null, true);
  check(`em zoom=1, fontSize de ambos começa em BASE_FONT_SIZE=15 (bash=${bashBefore}, claude=${claudeBefore})`, bashBefore, 15);
  check(`...claude também`, claudeBefore, 15);

  // Zoom-IN real via o botão da topbar (5 cliques, ~2x) — board zoom é
  // puramente óptico agora: fontSize NÃO deve mudar nem um pouco.
  const zoomInBtn = await centerOf(page, '.zoom-pill button[title="Aumentar zoom"]');
  for (let i = 0; i < 5; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
  }
  await new Promise((r) => setTimeout(r, 400));

  const bashAfterZoomIn = await fontSizeFor(page, ids.bashId);
  const claudeAfterZoomIn = await fontSizeFor(page, ids.claudeId);
  check(`bash: fontSize NÃO muda com zoom-in (era ${bashBefore}, continua ${bashAfterZoomIn})`, bashAfterZoomIn, bashBefore);
  check(`claude: fontSize NÃO muda com zoom-in (era ${claudeBefore}, continua ${claudeAfterZoomIn})`, claudeAfterZoomIn, claudeBefore);

  // Zoom-OUT real, até o mínimo do board — mesma garantia na outra
  // direção. Reproduz o zoom baixo que originalmente quebrava a
  // statusline; agora não há mais NADA reagindo a isso no terminal.
  const zoomOutBtn = await centerOf(page, '.zoom-pill button[title="Diminuir zoom"]');
  for (let i = 0; i < 20; i++) {
    await page.click(zoomOutBtn.x, zoomOutBtn.y);
  }
  await new Promise((r) => setTimeout(r, 400));
  const claudeZoomedOut = await fontSizeFor(page, ids.claudeId);
  check(
    `claude: fontSize NÃO muda nem no zoom-out mínimo do board (era ${claudeBefore}, continua ${claudeZoomedOut}) — nunca quebra colunas`,
    claudeZoomedOut,
    claudeBefore,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
