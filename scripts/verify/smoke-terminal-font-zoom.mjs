// DESIGN-BACKLOG.md item 57 ponto 10, revisado (SCREEN_SPACE_PROJECTION_
// PLAN.md, Trilha A) — a fonte do terminal agora acompanha o zoom do
// canvas 1:1 (`FONT_ZOOM_INFLUENCE = 1.0`), pra TODO provider, `bash`
// incluído — antes só 15% do delta afetava o tamanho real e só terminais
// com agente reagiam, o resto do blur em zoom continuava vindo do
// `transform: scale()` puramente óptico.
//
// Sinal usado: `terminal-registry.ts`'s `getTerminalFontSize(cardId)`,
// exposto em `window.__getTerminalFontSize` — lê `term.options.fontSize`
// direto da instância viva do xterm.js, o mesmo valor que
// `fontSizeForZoom` escreve. Substitui uma primeira versão deste teste
// que tentava inferir o fontSize por introspecção de canvas (contar
// canvases sem `style` explícito, comparar resolução crua vs. CSS) —
// achado ao vivo construindo isto: o canvas de medição de célula do
// xterm é recriado sob demanda e não fica estável logo após uma mutação
// de `fontSize`, e a razão resolução-crua/CSS do canvas de render
// principal reflete `devicePixelRatio` (constante nesta máquina), não o
// fontSize — nenhum dos dois é um sinal confiável. Ler o valor real
// direto da instância é preciso e não depende de nenhum desses detalhes
// de implementação do renderer.
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

  // O bash padrão semeado por bootIntoFreshSession já serve de segundo
  // card sob teste (Trilha A cobre TODO provider agora, bash incluído).
  // Cria um segundo terminal, provider "claude" (instalado de verdade
  // nesta máquina), como comparação.
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

  // Zoom in real via o botão da topbar (5 cliques, step 1.15 — App.tsx's
  // ZOOM_STEP — chega em ~2x) — mesmo mecanismo que um usuário usaria.
  const zoomInBtn = await centerOf(page, '.zoom-pill button[title="Aumentar zoom"]');
  for (let i = 0; i < 5; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 400));

  const bashAfter = await fontSizeFor(page, ids.bashId);
  const claudeAfter = await fontSizeFor(page, ids.claudeId);
  check(
    `claude: fontSize cresceu com o zoom-in (antes ${claudeBefore}, depois ${claudeAfter})`,
    claudeAfter > claudeBefore,
    true,
  );
  // Trilha A — antes deste fix, `providerId === "bash"` era excluído do
  // efeito: seu fontSize continuava travado em BASE_FONT_SIZE mesmo
  // depois de zoom-in (só o `scale()` esticava visualmente, borrando).
  // Agora reage igual a um terminal de agente.
  check(
    `bash: fontSize TAMBÉM cresceu com o mesmo zoom-in (antes ${bashBefore}, depois ${bashAfter}) — Trilha A`,
    bashAfter > bashBefore,
    true,
  );
  check(`bash e claude chegam no MESMO fontSize (mesma fórmula, mesmo zoom): bash=${bashAfter}, claude=${claudeAfter}`, bashAfter, claudeAfter);
  // Achado ao vivo (2026-09-02): o clamp era 11-22, bem mais estreito que
  // o range real de zoom do board (0.2-3.0) — a ~2x de zoom (este teste),
  // fontSize teórico é ~30, MAS travava em 22 e só o transform esticava,
  // borrando. Clamp widened pra 3-45 (os extremos matemáticos de
  // 15×[0.2,3.0]) — agora ~2x deve produzir fontSize MAIOR que o teto
  // antigo, prova de que o fix real está em vigor, não só o número certo.
  check(`fontSize a ~2x de zoom passa do teto ANTIGO (22) — clamp widened de verdade, não só travando mais alto`, bashAfter > 22, true);
  check(`...e continua dentro do teto NOVO (FONT_SIZE_MAX=45)`, bashAfter <= 45, true);

  // Zoom-out até o mínimo do board (0.2) — antes travava em 11, agora deve
  // chegar perto do novo piso (3 = 15×0.2, o próprio mínimo matemático).
  const zoomOutBtn = await centerOf(page, '.zoom-pill button[title="Diminuir zoom"]');
  for (let i = 0; i < 20; i++) {
    await page.click(zoomOutBtn.x, zoomOutBtn.y);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 400));
  const claudeZoomedOut = await fontSizeFor(page, ids.claudeId);
  check(
    `zoom-out no mínimo do board passa do piso ANTIGO (11) — fontSize real: ${claudeZoomedOut}`,
    claudeZoomedOut < claudeAfter && claudeZoomedOut < 11,
    true,
  );
  check(`...e respeita o piso NOVO (FONT_SIZE_MIN=3)`, claudeZoomedOut >= 3, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
