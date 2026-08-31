// Achado ao vivo (mesma varredura do resize "quebra e volta") —
// `useTerminal.ts`'s Effect 5 (fontSize acompanha o zoom, Trilha A
// original) disparava a mutação real de `fontSize` (realoca o atlas de
// glyphs WebGL do xterm) + `fit()` + resize de PTY em CADA tick de 0.1 no
// zoom, sem nenhum debounce — diferente do padrão que a Trilha A do
// navegador já usa (150ms). Um gesto de zoom rápido cruzando vários
// passos de 0.1 disparava várias realocações caras em sequência. Fix:
// mesmo par debounce+arredondamento de `BrowserCard.tsx`. Verifica ao
// vivo, mesma técnica de `smoke-browser-zoom-resolution.mjs`: poll
// contínuo do fontSize real durante uma rajada rápida de zoom-in, conta
// valores DISTINTOS vistos — deve ser só 2 (inicial -> final), nunca um
// por tick, provando o debounce funcionando de verdade, não só o
// resultado final batendo.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9537;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-terminal-font-zoom-debounce", import.meta.url).pathname;

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

async function fontSizeFor(page, cardId) {
  return await page.evalJs(`window.__getTerminalFontSize(${JSON.stringify(cardId)})`);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Terminal Font Zoom Debounce Teste");
  await new Promise((r) => setTimeout(r, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const cardId = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'terminal')?.id ?? null))
    `),
  );
  check("card de terminal real criado", typeof cardId === "string", true);

  const initialFontSize = await fontSizeFor(page, cardId);
  check("fontSize inicial real lido do xterm", typeof initialFontSize === "number", true);

  const zoomInBtn = await centerOf(page, '.zoom-pill button[title="Aumentar zoom"]');
  const seenSizes = [];
  const pollStop = Date.now() + 900;
  let pollTimer = null;
  const pollPromise = new Promise((resolve) => {
    function poll() {
      fontSizeFor(page, cardId).then((s) => {
        const key = JSON.stringify(s);
        if (seenSizes[seenSizes.length - 1] !== key) seenSizes.push(key);
        if (Date.now() < pollStop) pollTimer = setTimeout(poll, 40);
        else resolve();
      });
    }
    poll();
  });

  // Rajada RÁPIDA — bem mais rápido que o debounce de 150ms, ao contrário
  // do smoke-terminal-font-zoom.mjs's próprio ritmo (150ms entre cliques,
  // deliberadamente espaçado pra testar OUTRA coisa: os valores finais).
  for (let i = 0; i < 6; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
    await new Promise((r) => setTimeout(r, 30));
  }

  await pollPromise;
  if (pollTimer) clearTimeout(pollTimer);

  check(
    "fontSize real só transicionou UMA vez durante a rajada de zoom (debounce funcionando, não uma realocação por tick)",
    seenSizes.length,
    2,
  );

  const finalFontSize = await fontSizeFor(page, cardId);
  check("fontSize real cresceu de verdade com o zoom", finalFontSize > initialFontSize, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
