// Achado ao vivo ("navegador parece 360p") — causa raiz confirmada direto
// no electron.d.ts da versão instalada (42.3.0): `webPreferences.offscreen`
// aceita um `deviceScaleFactor`, que É 1 por padrão se não setado —
// independente do monitor real. Toda BrowserWindow offscreen deste app
// rasterizava em densidade 1x mesmo numa tela HiDPI. Fix:
// `browser-registry.ts`'s `create()` agora passa o scaleFactor real do
// display onde a janela do app está. Verifica ao vivo, sem mock: um
// frame `browser:frame` REAL capturado tem largura/altura em pixels
// exatamente `contentSize.w/h * scaleFactor` — prova a cadeia de
// multiplicação de verdade, funciona não importa o scaleFactor real da
// máquina de teste (mesmo se for 1, a igualdade ainda é uma checagem
// real da fiação, não um valor cravado).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9538;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-scale-factor", import.meta.url).pathname;

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

async function createBrowserCard(page) {
  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const browserCards = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser').map((c) => c.id)))
    `),
  );
  return browserCards[browserCards.length - 1];
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Scale Factor Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const cardId = await createBrowserCard(page);
  check("browser card real criado", typeof cardId === "string" && cardId.length > 0, true);

  const contentSize = await page.evalJs(`window.debugBridge.browserContentSize(${JSON.stringify(cardId)})`);
  check("contentSize real reporta scaleFactor real (número > 0)", typeof contentSize?.scaleFactor === "number" && contentSize.scaleFactor > 0, true);

  await page.evalJs(`window.__lastBrowserFrameSize = null;`);
  await page.evalJs(`
    (() => {
      window.browser.onFrame((id, buffer, width, height) => {
        if (id === ${JSON.stringify(cardId)}) window.__lastBrowserFrameSize = { width, height };
      });
      return true;
    })()
  `);
  // Poll em vez de espera fixa (achado ao vivo, 2026-09-02, adicionando o
  // supersample fixo 3× — ver browser-registry.ts's BROWSER_SUPERSAMPLE):
  // o primeiro paint real, mesmo de about:blank, ficou mensuravelmente mais
  // lento com 9× mais pixels de raster/encode por trás (visto na prática:
  // ~400ms, contra a folga confortável que uma espera fixa de 500ms tinha
  // antes do supersample) — poll de 3s dá margem real sem travar o teste
  // se algo realmente quebrar.
  let frameSize = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    frameSize = await page.evalJs(`window.__lastBrowserFrameSize`);
    if (frameSize) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  check("um frame browser:frame real chegou pro card", frameSize !== null, true);

  const expectedW = Math.round(contentSize.w * contentSize.scaleFactor);
  const expectedH = Math.round(contentSize.h * contentSize.scaleFactor);
  check(
    `frame real capturado tem largura em pixels == contentSize.w × scaleFactor (esperado ${expectedW}, real ${frameSize?.width})`,
    frameSize?.width,
    expectedW,
  );
  check(
    `frame real capturado tem altura em pixels == contentSize.h × scaleFactor (esperado ${expectedH}, real ${frameSize?.height})`,
    frameSize?.height,
    expectedH,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
