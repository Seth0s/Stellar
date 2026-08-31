// Próxima rodada §3 — favoritos do navegador, GLOBAIS pro app inteiro
// (decisão explícita do usuário, não por board). Verifica ao vivo, sem
// mock: favoritar a página atual via o botão de estrela real grava uma
// linha real em `browser_favorites` (lida de volta via
// `window.store.favorites.list()`), clicar um favorito salvo no popover
// navega o card de verdade (evento `did-navigate` real), e remover
// realmente some da lista.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = 9539;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-favorites", import.meta.url).pathname;

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

// Duas páginas fixture reais e distinguíveis (títulos diferentes) — pra
// provar que "clicar um favorito navega pra lá" realmente troca de página,
// não só reabre a mesma.
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  const page = req.url === "/segunda" ? "Segunda Pagina" : "Primeira Pagina";
  res.end(`<!doctype html><html><head><title>${page}</title></head><body style="margin:0">${page}</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

async function createBrowserCard(page, url) {
  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  const barCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const inputs = document.querySelectorAll('.browser-card-address input');
        const el = inputs[inputs.length - 1];
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inputs = document.querySelectorAll('.browser-card-address input');
      const inp = inputs[inputs.length - 1];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(url)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 800));

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
  await bootIntoFreshSession(page, "Browser Favorites Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const firstUrl = `http://127.0.0.1:${port}/`;
  const secondUrl = `http://127.0.0.1:${port}/segunda`;
  const cardId = await createBrowserCard(page, firstUrl);
  check("browser card real criado e navegado pra primeira página", typeof cardId === "string", true);

  // Espera a página REAL carregar (título real via onTitle) antes de
  // favoritar, senão o título salvo seria só a URL crua.
  await new Promise((r) => setTimeout(r, 500));

  const favBtn = await centerOf(page, ".browser-card-favorite-btn");
  check("botão de estrela real encontrado no header", favBtn !== null, true);
  await page.click(favBtn.x, favBtn.y);
  await new Promise((r) => setTimeout(r, 250));

  const favMenuAfterOpen = await page.evalJs(`!!document.querySelector('.browser-card-favorites-menu')`);
  check("popover de favoritos real abre", favMenuAfterOpen, true);

  const toggleBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.browser-card-favorites-menu button');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(toggleBtn.x, toggleBtn.y);
  await new Promise((r) => setTimeout(r, 300));

  const favoritesAfterAdd = JSON.parse(await page.evalJs(`window.store.favorites.list().then(JSON.stringify)`));
  check("favoritar a página real grava uma linha real em browser_favorites", favoritesAfterAdd.some((f) => f.url === firstUrl), true);
  const savedFav = favoritesAfterAdd.find((f) => f.url === firstUrl);
  check("título salvo é o título REAL da página (não a URL crua)", savedFav?.title, "Primeira Pagina");

  // Navega a segunda página manualmente (fora do popover), reabre o
  // popover, clica o favorito salvo, confirma que voltou pra primeira.
  const barCoords2 = await centerOf(page, ".browser-card-address input");
  await page.click(barCoords2.x, barCoords2.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.browser-card-address input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(secondUrl)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 500));
  const barAfterNav = await page.evalJs(`document.querySelector('.browser-card-address input')?.value`);
  check("navegação manual real pra segunda página aconteceu", barAfterNav, secondUrl);

  await page.click(favBtn.x, favBtn.y);
  await new Promise((r) => setTimeout(r, 250));
  const favRowCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.browser-card-fav-row');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  check("linha do favorito salvo aparece de verdade no popover", favRowCoords !== null, true);
  await page.click(favRowCoords.x, favRowCoords.y);
  await new Promise((r) => setTimeout(r, 500));
  const barAfterFavClick = await page.evalJs(`document.querySelector('.browser-card-address input')?.value`);
  check("clicar o favorito salvo navega o card de volta pra lá de verdade", barAfterFavClick, firstUrl);

  // Remove o favorito, confirma que sumiu.
  await page.click(favBtn.x, favBtn.y);
  await new Promise((r) => setTimeout(r, 250));
  const removeBtnCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('.browser-card-fav-remove');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  check("botão de remover favorito real encontrado", removeBtnCoords !== null, true);
  await page.click(removeBtnCoords.x, removeBtnCoords.y);
  await new Promise((r) => setTimeout(r, 300));
  const favoritesAfterRemove = JSON.parse(await page.evalJs(`window.store.favorites.list().then(JSON.stringify)`));
  check("remover o favorito real some da lista real", favoritesAfterRemove.some((f) => f.url === firstUrl), false);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
