// Bug real achado ao vivo (2026-09-01, feedback do usuário: "está
// impreciso o click"): `BrowserCard.tsx`'s `toCanvasPoint` mapeava a
// fração do clique dentro do retângulo REAL na tela pelo tamanho de
// MUNDO do card (`rect.w`/`rect.h`, pré-zoom) — mas o espaço de
// coordenadas que `sendInputEvent` espera é o content size REAL da
// BrowserWindow offscreen, que a Trilha A do navegador já escala pelo
// mesmo zoom (`browser-registry.ts`'s `resize()`). Em zoom=1 os dois
// tamanhos coincidem por acaso (nenhum teste em zoom!=1 existia até
// agora), mas em qualquer outro zoom o clique media só uma fração do
// espaço real — em zoom=2, por exemplo, clicar perto do canto/borda do
// card na tela mandava a coordenada pra literalmente METADE da posição
// real dentro da página embutida.
//
// Verifica ao vivo, sem mock: um botão real fixado perto do rodapé da
// viewport da página (`position: fixed; bottom`), zoom do board setado
// pra 200% via o campo de entrada direta do zoom-pill (não s
// aproximações de scroll/wheel), clique real disparado exatamente na
// posição da tela que DEVERIA acertar o botão (calculada a partir do
// content size REAL pós-clamp, mesma fórmula do fix) — confirma que o
// clique realmente chegou nele via `window.browser.onTitle` (o botão só
// muda o título real da página no seu próprio onclick).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = 9541;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-click-zoom-precision", import.meta.url).pathname;

// Mesmo clamp de browser-registry.ts's BROWSER_ZOOM_MIN/MAX.
const BROWSER_ZOOM_MIN = 0.5;
const BROWSER_ZOOM_MAX = 3;

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

// Botão real numa posição absoluta perto do CENTRO do content space (não
// perto de um canto) — em zoom=200% o card fica maior que a própria
// janela e zoom centraliza no centro do card, então qualquer alvo perto
// de uma borda/canto do CONTEÚDO cai fora da área visível da tela real
// (achado ao vivo construindo este teste). Um deslocamento modesto a
// partir do centro (150,120) ainda distingue claramente a versão com bug
// (que manda a coordenada pra METADE da posição real — em zoom=2 isso
// entrega um deslocamento de só (75,60) a partir do centro, fora do
// alcance do botão) da versão corrigida, e continua dentro da área
// visível de qualquer janela razoável.
const TARGET_LEFT = 1010;
const TARGET_TOP = 780;
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><head><title>antes</title></head><body style="margin:0;">
    <button id="btn" style="position:fixed;left:${TARGET_LEFT}px;top:${TARGET_TOP}px;width:60px;height:30px;"
      onclick="document.title='clicked-target'">Alvo</button>
  </body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Browser Click Zoom Precision Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const browserBtn = await centerOf(page, '.rail-btn[title="Novo navegador"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  const barCoords = await centerOf(page, ".browser-card-address input");
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.browser-card-address input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(`http://127.0.0.1:${port}/`)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 800));

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const browserCards = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) => JSON.stringify(cards.filter((c) => c.kind === 'browser')))
    `),
  );
  const card = browserCards[browserCards.length - 1];
  check("browser card real criado e navegado", typeof card?.id === "string", true);

  // Sobe o zoom do board pra exatos 200% via o campo de entrada direta
  // do zoom-pill (não aproximação por cliques/scroll) — precisão exata é
  // o ponto inteiro deste teste.
  const zoomReadout = await centerOf(page, ".zoom-readout");
  await page.click(zoomReadout.x, zoomReadout.y);
  await new Promise((r) => setTimeout(r, 200));
  const zoomInputCoords = await centerOf(page, ".zoom-input");
  await page.click(zoomInputCoords.x, zoomInputCoords.y);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('.zoom-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '200');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  // >150ms do debounce do resize-por-zoom em BrowserCard.tsx, mais folga
  // real pra transição CSS do `.world` (0.28s, layout.css) assentar de
  // verdade — medido ao vivo que a 600ms a `getBoundingClientRect` do
  // canvas ainda pegava um valor a meio caminho da transição.
  await new Promise((r) => setTimeout(r, 3000));

  const zoomText = await page.evalJs(`document.querySelector('.zoom-readout')?.textContent ?? ""`);
  check(`board real em 200% de zoom (leitura real: "${zoomText}")`, zoomText.trim(), "200%");

  // Calcula a posição na TELA que deveria acertar o botão, a partir do
  // content size REAL pós-clamp (mesma fórmula do fix em BrowserCard.tsx
  // e de resize() em browser-registry.ts) — não um valor cravado.
  const effectiveZoom = Math.min(BROWSER_ZOOM_MAX, Math.max(BROWSER_ZOOM_MIN, 2));
  const contentH = Math.max(1, Math.round(card.h * effectiveZoom));
  const contentW = Math.max(1, Math.round(card.w * effectiveZoom));
  // Centro real do botão no espaço de conteúdo.
  const targetFractionX = (TARGET_LEFT + 30) / contentW;
  const targetFractionY = (TARGET_TOP + 15) / contentH;

  const canvasBox = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame.browser-card canvas');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
      })()
    `),
  );
  check("canvas real do browser card encontrado na tela", canvasBox !== null, true);

  const clickX = canvasBox.left + targetFractionX * canvasBox.width;
  const clickY = canvasBox.top + targetFractionY * canvasBox.height;

  await page.evalJs(`
    (() => {
      window.__titleAfterClick = null;
      window.browser.onTitle((id, title) => {
        if (id === ${JSON.stringify(card.id)}) window.__titleAfterClick = title;
      });
      return true;
    })()
  `);
  await page.click(clickX, clickY);
  await new Promise((r) => setTimeout(r, 500));

  const titleAfterClick = await page.evalJs(`window.__titleAfterClick`);
  check(
    `clique real em zoom=200% acerta o botão de verdade (espaço de conteúdo real ${contentW}x${contentH}, canvas na tela ${JSON.stringify(canvasBox)}, clique em (${Math.round(clickX)},${Math.round(clickY)}), título real depois: ${titleAfterClick})`,
    titleAfterClick,
    "clicked-target",
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
