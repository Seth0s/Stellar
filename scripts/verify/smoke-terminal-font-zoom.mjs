// DESIGN-BACKLOG.md item 57 ponto 10, revisado de novo (2026-09-02,
// pedido explícito do usuário) — `fontSize = BASE / zoom` (INVERSO do
// zoom do board), pra TODO provider, `bash` incluído. Zoom-IN encolhe o
// fontSize (até o piso) — o oposto da versão anterior deste mecanismo
// (`fontSize = BASE * zoom`), que fazia o tamanho aparente na tela
// crescer/encolher ao QUADRADO do zoom (a fonte já escala 1:1 com o
// `transform: scale()` do card por fora; multiplicar o fontSize interno
// pelo MESMO zoom compunha as duas escalas).
//
// Revisado de novo (2026-09-03) — zoom-OUT NÃO cresce mais o fontSize
// além de `BASE_FONT_SIZE`: crescer mantinha o tamanho aparente
// constante, mas Effect 5 (useTerminal.ts) refaz o fit() de cols/rows
// contra a largura FIXA do container logo depois, então fonte maior
// sempre significava menos colunas reais — reproduzido ao vivo quebrando
// a statusline do Claude Code em 2 linhas de fonte gigante a zoom baixo.
// Ver o comentário de `fontSizeForZoom` em useTerminal.ts pra matemática
// completa e o trade-off aceito (tamanho aparente deixa de ser
// constante no zoom-out, em troca de nunca mais quebrar/cortar conteúdo).
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
  // Fórmula inversa (2026-09-02): zoom-IN agora ENCOLHE o fontSize (era
  // o contrário antes da correção de direção).
  check(
    `claude: fontSize ENCOLHEU com o zoom-in (antes ${claudeBefore}, depois ${claudeAfter}) — fórmula inversa`,
    claudeAfter < claudeBefore,
    true,
  );
  // Trilha A — todo provider reage igual, `bash` incluído (mesma fórmula,
  // sem exceção por provider).
  check(
    `bash: fontSize TAMBÉM encolheu com o mesmo zoom-in (antes ${bashBefore}, depois ${bashAfter}) — Trilha A`,
    bashAfter < bashBefore,
    true,
  );
  check(`bash e claude chegam no MESMO fontSize (mesma fórmula, mesmo zoom): bash=${bashAfter}, claude=${claudeAfter}`, bashAfter, claudeAfter);
  // A ~2x de zoom, fontSize teórico = 15/2.01 ≈ 7 — bem acima do piso
  // (FONT_SIZE_MIN=3), prova que o clamp não está mascarando o cálculo.
  check(`fontSize a ~2x de zoom ainda está acima do piso (FONT_SIZE_MIN=3): ${bashAfter}`, bashAfter > 3, true);
  check(`...e dentro do teto (nunca passa de BASE_FONT_SIZE=15)`, bashAfter <= 15, true);

  // Revisado ao vivo (2026-09-03, zoom 43%, statusline do Claude Code
  // quebrando/cortando) — a versão anterior deste teste esperava o
  // fontSize CRESCER até um teto de 45 no zoom mínimo do board (fórmula
  // inversa "pura"). Reproduzido ao vivo: como Effect 5 (useTerminal.ts)
  // refaz o fit() de cols/rows contra a largura FIXA do container logo
  // depois de mudar o fontSize, uma fonte maior sempre significa MENOS
  // colunas reais — no zoom mínimo, isso quebrava a statusline em 2
  // linhas de fonte gigante. Não existe piso de colunas genérico e seguro
  // pra qualquer conteúdo (o quanto uma CLI precisa varia) — a única
  // garantia que nunca quebra é NUNCA deixar a fonte passar do próprio
  // tamanho de zoom=1, então zoom-out agora mantém o fontSize (não cresce
  // mais), trade-off aceito explicitamente com o usuário em troca de
  // nunca mais cortar/quebrar conteúdo.
  const zoomOutBtn = await centerOf(page, '.zoom-pill button[title="Diminuir zoom"]');
  for (let i = 0; i < 20; i++) {
    await page.click(zoomOutBtn.x, zoomOutBtn.y);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 400));
  const claudeZoomedOut = await fontSizeFor(page, ids.claudeId);
  check(
    `zoom-out no mínimo do board NÃO cresce mais o fontSize além de zoom=1 (base=${claudeBefore}, zoomed-out=${claudeZoomedOut}) — nunca quebra colunas`,
    claudeZoomedOut <= claudeBefore,
    true,
  );
  check(`...e não passa de BASE_FONT_SIZE=15 em nenhum zoom <= 1`, claudeZoomedOut, 15);

  page.close();
} finally {
  await stopApp(app);
}
finish();
