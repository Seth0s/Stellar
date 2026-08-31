// DESIGN-BACKLOG.md item 57 ponto 10 — pedido ao vivo: fonte do terminal
// deveria acompanhar levemente o zoom do canvas, só pra terminais com um
// agente ativo (não bash puro). xterm.js renderiza em canvas/WebGL, sem
// texto de DOM confiável, e `window.pty` é congelado pelo próprio
// `contextBridge` (confirmado ao vivo tentando monkey-patch
// `window.pty.resize` — reatribuição vira um no-op silencioso, `Object.
// isFrozen(window.pty)` retorna `true`) — não dá pra observar a chamada
// de resize interceptando o IPC do jeito que outros testes fazem pro
// SDK da Anthropic.
//
// Sinal real usado em vez disso: xterm.js mantém um canvas interno de
// medição de célula (sem `style.width`/`style.height` — os únicos dois
// canvases "reais" de render sempre ganham esses estilos explícitos) cujo
// `.width`/`.height` (atributos HTML crus, não `getBoundingClientRect`)
// refletem o tamanho real da célula de caractere em pixels — um valor
// calculado pelo próprio xterm.js a partir do `fontSize` ativo, e que
// **não** é afetado pelo `transform: scale()` que o card-frame aplica por
// fora (transform CSS não muda o layout box de um elemento, só a pintura).
// Confirmado ao vivo antes de escrever isto: esse canvas mede 56×38 num
// card "claude" recém-criado e vira 64×41 depois de 5 cliques de zoom-in
// (~2×); o mesmo canvas num card "bash" fica em 56×26 antes E depois —
// prova real de que só o card com agente reagiu.
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

// Cada `.terminal-card` tem 3 canvases: link-layer e o de render principal
// (ambos com `style.width/height` explícitos) e o de medição de célula
// (sem nenhum dos dois) — o único cujo `.width`/`.height` cru muda com o
// fontSize real. Achado ao vivo: esse 3º canvas nasce ATRASADO (alguns
// segundos depois do card aparecer, não junto com os outros dois) — um
// card recém-criado pode legitimamente não ter ele ainda; poll curto em
// vez de assumir presença imediata.
async function cellCanvasDimsFor(page, cardId, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = JSON.parse(
      await page.evalJs(`
        (async () => {
          const boards = await window.store.boards.list();
          const cards = await window.store.list(boards[0].id);
          const domCards = [...document.querySelectorAll('.terminal-card')];
          // A ordem do DOM não é garantida ser a mesma da lista do store
          // (z-order pode reordenar) — encontra o card certo pelo texto do
          // header (provider/label) em vez de por índice.
          const card = domCards.find((el) => el.textContent.includes(cards.find((c) => c.id === ${JSON.stringify(cardId)}).provider));
          if (!card) return JSON.stringify(null);
          const canvas = [...card.querySelectorAll('canvas')].find((c) => !c.style.width && !c.style.height);
          if (!canvas) return JSON.stringify(null);
          return JSON.stringify({ w: canvas.width, h: canvas.height });
        })()
      `),
    );
    if (result !== null || Date.now() > deadline) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Terminal Font Zoom Teste");
  await new Promise((r) => setTimeout(r, 800));

  // O bash padrão semeado por bootIntoFreshSession já serve de card de
  // controle (provider "bash"). Cria um segundo terminal, provider
  // "claude" (instalado de verdade nesta máquina).
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
  check("card bash (controle) e card claude (agente) ambos existem", ids.bashId !== undefined && ids.claudeId !== undefined, true);

  const bashBefore = await cellCanvasDimsFor(page, ids.bashId);
  const claudeBefore = await cellCanvasDimsFor(page, ids.claudeId);
  check("consegue medir o canvas de célula do card bash antes do zoom", bashBefore !== null, true);
  check("consegue medir o canvas de célula do card claude antes do zoom", claudeBefore !== null, true);

  // Zoom in real via o botão da topbar — mesmo mecanismo que um usuário usaria.
  const zoomInBtn = await centerOf(page, '.zoom-pill button[title="Aumentar zoom"]');
  for (let i = 0; i < 5; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 300));

  const bashAfter = await cellCanvasDimsFor(page, ids.bashId);
  const claudeAfter = await cellCanvasDimsFor(page, ids.claudeId);

  check(
    "depois do zoom, a célula do card claude (agente) MUDOU de tamanho real (fontSize acompanhou o zoom)",
    claudeAfter.w !== claudeBefore.w || claudeAfter.h !== claudeBefore.h,
    true,
  );
  check(
    "...e cresceu (zoom in → fonte maior), não diminuiu",
    claudeAfter.w >= claudeBefore.w && claudeAfter.h >= claudeBefore.h,
    true,
  );
  check(
    "o card bash (controle) NÃO mudou de tamanho de célula com o mesmo zoom (fonte fixa pra bash puro)",
    bashAfter.w === bashBefore.w && bashAfter.h === bashBefore.h,
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
