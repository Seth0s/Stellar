// DESIGN-BACKLOG.md §2.1 Item B — Trilha A do navegador originalmente fazia
// a resolução real da BrowserWindow offscreen acompanhar o zoom do board
// (ver git history / commit anterior deste arquivo pra essa versão). Achado
// ao vivo pelo usuário testando isso (2026-09-02): num teste de zoom bem
// alto (perto do antigo teto de 3), o navegador ficou "quase 4k
// completamente nítido" — a resolução real subia até 3× a densidade real do
// monitor, um trade-off real (mais nítido, mas re-renderiza a página e
// recodifica um JPEG maior a cada passo de zoom) que ele não pediu e não
// queria. Pedido explícito: "o navegador não precisa ser afetado pelo
// efeito do zoom aumentar ou diminuir a fonte" — revertido.
//
// Este teste agora prova o invariante OPOSTO do que provava antes: a
// resolução real do BrowserWindow offscreen NÃO muda com o zoom do board,
// nem durante uma rajada de zoom nem no valor final — só o `scaleFactor`
// real do monitor e o `BROWSER_SUPERSAMPLE` fixo (smoke-browser-scale-
// factor.mjs, browser-registry.ts) e um resize genuíno do rect (smoke-
// card-resize-and-surgical-snapshot.mjs) ainda mudam a resolução real. O
// card continua ficando visualmente maior/menor na tela durante o zoom
// (isso é só o `scale(zoom)` do `.world`/projeção de tela, como qualquer
// outro card) — só o raster real por trás do JPEG que fica parado.
//
// BROWSER_SUPERSAMPLE (2026-09-02, pedido explícito do usuário: "mandar
// renderizar o triplo da resolução") — o valor inicial esperado abaixo
// precisa incluir esse fator fixo, não só `scaleFactor`; ver browser-
// registry.ts's `resize` doc comment pro porquê (supersample fixo,
// independente do zoom, decoupled igual ao resto deste arquivo).
//
// BROWSER_MAX_DENSITY (2026-09-02, mesma sessão, achado ao vivo no log do
// dev server num monitor 4K real: "travar" era o custo quadrático do
// supersample fixo escalando com `scaleFactor` do monitor sem teto) — o
// factor real aplicado por `resize()` é `min(scaleFactor × BROWSER_SUPERSAMPLE,
// BROWSER_MAX_DENSITY)`, não só `scaleFactor × BROWSER_SUPERSAMPLE`. Nesta
// máquina de teste (scaleFactor=1) o teto já domina (1×3=3 > 2).
const BROWSER_SUPERSAMPLE = 3;
const BROWSER_MAX_DENSITY = 2;
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-zoom-resolution-${CDP_PORT}`, import.meta.url).pathname;

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
            const b = document.querySelector('[data-role="rail-add-card"]');
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

async function createBrowserCard(page) {
  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const browserCards = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => ({ id: c.id, w: c.w, h: c.h }))))
    `),
  );
  return { boardId, ...browserCards[browserCards.length - 1] };
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Zoom Resolution Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const { id: cardId, w: rectW, h: rectH } = await createBrowserCard(page);
  check("browser card real criado", typeof cardId === "string" && cardId.length > 0, true);

  async function contentSize() {
    return await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(cardId)})`);
  }

  const initialSize = await contentSize();
  const expectedFactor = Math.min(initialSize.scaleFactor * BROWSER_SUPERSAMPLE, BROWSER_MAX_DENSITY);
  check(
    "resolução inicial do BrowserWindow offscreen bate com o rect × factor (scaleFactor × BROWSER_SUPERSAMPLE, capado em BROWSER_MAX_DENSITY) (sem zoom aplicado ainda)",
    JSON.stringify({ w: initialSize.w, h: initialSize.h }),
    JSON.stringify({
      w: Math.round(rectW * expectedFactor),
      h: Math.round(rectH * expectedFactor),
    }),
  );

  const zoomInBtn = await centerOf(page, '.zoom-pill button[title="Aumentar zoom"]');
  const seenSizes = new Set([JSON.stringify({ w: initialSize.w, h: initialSize.h })]);
  const pollStop = Date.now() + 900;
  let pollTimer = null;
  const pollPromise = new Promise((resolve) => {
    function poll() {
      contentSize().then((s) => {
        seenSizes.add(JSON.stringify({ w: s.w, h: s.h }));
        if (Date.now() < pollStop) pollTimer = setTimeout(poll, 40);
        else resolve();
      });
    }
    poll();
  });

  // Mesma rajada de 5 cliques rápidos que o comportamento antigo (Trilha A)
  // debounçava em um resize real — agora não deve disparar resize NENHUM.
  for (let i = 0; i < 5; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
    await new Promise((r) => setTimeout(r, 60));
  }

  await pollPromise;
  if (pollTimer) clearTimeout(pollTimer);

  const zoomText = await page.evalJs(`document.querySelector('.zoom-readout')?.textContent ?? ""`);
  check(`zoom do board real subiu de verdade durante a rajada (leitura real: "${zoomText}")`, zoomText.trim() !== "100%", true);

  check(
    "resolução real do BrowserWindow offscreen NUNCA mudou durante a rajada de zoom (um só tamanho visto o tempo todo — decoupled do zoom a pedido do usuário)",
    seenSizes.size,
    1,
  );

  const finalSize = await contentSize();
  check(
    "resolução real do BrowserWindow offscreen continua igual à inicial depois da rajada (não só durante)",
    JSON.stringify({ w: finalSize.w, h: finalSize.h }),
    JSON.stringify({ w: initialSize.w, h: initialSize.h }),
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
