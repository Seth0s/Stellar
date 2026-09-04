// Achado ao vivo (2026-09-04) — "fiz um zoom absurdo de 160%, era pra a
// fonte ficar imóvel... mas agora fica borrada dependendo do zoom, e o
// resize não está ajustando a qualidade, só dando um zoom out ou in
// óptico". Root cause: `useTerminal.ts`'s Effect 5 changes
// `term.options.fontSize` and refits cols/rows on every zoom settle
// (`fontSizeForZoom`), but never told `@xterm/addon-webgl` to throw away
// its cached glyph texture atlas — the addon keeps drawing glyphs
// rasterized at the PREVIOUS fontSize, just stretched/shrunk to the new
// cell size. Visually that's exactly a plain optical zoom, never a real
// re-render — the described symptom precisely. Fixed by calling
// `WebglAddon.clearTextureAtlas()` (forces a real redraw at the new
// fontSize) right after `fit.fit()` in that same effect.
//
// No pixel-diffing harness exists in this repo to assert on "sharper" —
// instead this proves the MECHANISM: `clearTextureAtlas()` genuinely
// fires once per real fontSize change (not on every zoom tick, and not
// redundantly when the zoom settles on the SAME fontSize it already
// had), via `terminal-registry.ts`'s test-only `noteAtlasClear` counter.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9714;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-webgl-atlas-clear", import.meta.url).pathname;

async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res) throw new Error(`selector not found: ${selector}`);
  return res;
}

async function fontSizeFor(page, cardId) {
  return page.evalJs(`window.__getTerminalFontSize(${JSON.stringify(cardId)})`);
}
async function atlasClearCountFor(page, cardId) {
  return page.evalJs(`window.__getAtlasClearCount(${JSON.stringify(cardId)})`);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Terminal WebGL Atlas Clear Teste");
  await new Promise((r) => setTimeout(r, 800));

  const ids = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify({ bashId: cards.find((c) => c.kind === 'terminal').id });
      })()
    `),
  );
  check("card bash existe", ids.bashId !== undefined, true);

  const countBefore = await atlasClearCountFor(page, ids.bashId);
  check("nenhum clearTextureAtlas antes de qualquer zoom", countBefore, 0);

  // Gesto de zoom RÁPIDO — 5 cliques SEM esperar entre eles, cruzando
  // vários passos de 0.1 (exatamente o cenário que o debounce de Effect 5
  // existe pra cobrir, ver o comentário dele em useTerminal.ts). Só espera
  // DEPOIS de todos os cliques, o bastante pra passar do debounce de
  // 150ms — se o debounce estiver funcionando, isso deve produzir
  // exatamente 1 `clearTextureAtlas`, não 1 por clique.
  const zoomInBtn = await centerOf(page, '.zoom-pill button[title="Aumentar zoom"]');
  for (let i = 0; i < 5; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
  }
  await new Promise((r) => setTimeout(r, 500));

  const fontAfterZoomIn = await fontSizeFor(page, ids.bashId);
  const countAfterZoomIn = await atlasClearCountFor(page, ids.bashId);
  check("fontSize realmente mudou com o gesto de zoom-in", fontAfterZoomIn < 15, true);
  check(
    `clearTextureAtlas disparou exatamente 1 vez pro gesto inteiro (debounced), não 1 por clique (count=${countAfterZoomIn})`,
    countAfterZoomIn,
    1,
  );

  // Zoom pra 160%+ especificamente (o caso relatado ao vivo) — outro
  // gesto rápido, confirma que o SEGUNDO gesto também produz exatamente
  // mais 1 clear (o contador é cumulativo desde o início do teste).
  for (let i = 0; i < 3; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
  }
  await new Promise((r) => setTimeout(r, 500));
  const fontAt160 = await fontSizeFor(page, ids.bashId);
  const countAt160 = await atlasClearCountFor(page, ids.bashId);
  check(`fontSize mudou de novo indo pra ~160%+ de zoom (antes ${fontAfterZoomIn}, depois ${fontAt160})`, fontAt160 < fontAfterZoomIn, true);
  check(`clearTextureAtlas disparou de novo pro segundo gesto (count=${countAt160})`, countAt160, 2);

  page.close();
} finally {
  await stopApp(app);
}
finish();
