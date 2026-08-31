// DESIGN-BACKLOG.md §2.1 Item B — Trilha A do navegador. Verifies the
// offscreen BrowserWindow's REAL rendered resolution (not just the CSS
// `transform: scale()` optical size) tracks board zoom, and that a burst
// of rapid zoom ticks debounces into a SINGLE real resize instead of one
// per tick — confirmed by polling the real content size throughout the
// burst and counting distinct values seen, not just the final result.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9534;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-zoom-resolution", import.meta.url).pathname;

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
  check(
    "resolução inicial do BrowserWindow offscreen bate com o rect no zoom 1:1",
    JSON.stringify({ w: initialSize.w, h: initialSize.h }),
    JSON.stringify({ w: rectW, h: rectH }),
  );

  const zoomInBtn = await centerOf(page, '.zoom-pill button[title="Aumentar zoom"]');
  const seenSizes = [];
  const pollStop = Date.now() + 900;
  let pollTimer = null;
  const pollPromise = new Promise((resolve) => {
    function poll() {
      contentSize().then((s) => {
        const key = JSON.stringify(s);
        if (seenSizes[seenSizes.length - 1] !== key) seenSizes.push(key);
        if (Date.now() < pollStop) pollTimer = setTimeout(poll, 40);
        else resolve();
      });
    }
    poll();
  });

  // 5 cliques rápidos em sequência — cada um dispara um re-render com um
  // novo `zoom`, resetando o debounce de 150ms do BrowserCard.tsx; só o
  // ÚLTIMO sobrevive quieto o bastante pra realmente disparar um resize.
  for (let i = 0; i < 5; i++) {
    await page.click(zoomInBtn.x, zoomInBtn.y);
    await new Promise((r) => setTimeout(r, 60));
  }

  await pollPromise;
  if (pollTimer) clearTimeout(pollTimer);

  check(
    "resolução real só transicionou UMA vez durante a rajada de zoom (debounce funcionando, não um resize por tick)",
    seenSizes.length,
    2,
  );

  const finalSize = await contentSize();
  check("resolução real do BrowserWindow offscreen cresceu de verdade (não só o CSS scale óptico)", finalSize.w > initialSize.w && finalSize.h > initialSize.h, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
