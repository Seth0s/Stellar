// Bug real achado ao vivo (2026-09-01, feedback do usuário: "está
// impreciso o click"): `BrowserCard.tsx`'s `toCanvasPoint` mapeava a
// fração do clique dentro do retângulo REAL na tela pelo tamanho de
// MUNDO do card (`rect.w`/`rect.h`), mas o espaço de coordenadas que
// `sendInputEvent` espera é o content size REAL da BrowserWindow
// offscreen (`browser-registry.ts`'s `resize()`) — que na época deste
// teste também escalava pelo zoom do board (Trilha A), e desde
// 2026-09-02 (pedido explícito do usuário) só escala pelo `scaleFactor`
// real do monitor. Em qualquer um dos dois casos, o teste continua
// válido: `toCanvasPoint` mapeia por FRAÇÃO do box visual (que a
// transform CSS de zoom do `.world` sempre muda), então mesmo com o
// content size agora fixo independente do zoom, um clique preciso em
// zoom=200% só se mantém correto se a fração for calculada certa — a
// regressão que este teste pega não mudou de natureza, só a fórmula do
// content size esperado mudou (lida ao vivo agora, não recalculada aqui).
//
// Verifica ao vivo, sem mock: um botão real fixado perto do rodapé da
// viewport da página (`position: fixed; bottom`), zoom do board setado
// pra 200% via o campo de entrada direta do zoom-pill (não
// aproximações de scroll/wheel), clique real disparado exatamente na
// posição da tela que DEVERIA acertar o botão (calculada a partir do
// content size REAL, lido de `debugBridge.browserContentSize`, não
// recomputado por uma fórmula duplicada aqui) — confirma que o clique
// realmente chegou nele via `window.browser.onTitle` (o botão só muda o
// título real da página no seu próprio onclick).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = 9541;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-browser-click-zoom-precision", import.meta.url).pathname;

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

// Botão ancorado no CENTRO do content space via `left/top: 50%` +
// `translate(-50%,-50%)` — nunca em pixels absolutos. Achado ao vivo
// construindo este teste (2026-09-02, depois da mudança que desacopla a
// resolução real do zoom do board — ver browser-registry.ts's `resize`):
// um alvo em pixel absoluto calibrado pro content space ANTIGO (que
// crescia com o zoom) cai fora da página real agora que o content space
// fica fixo independente do zoom — a página deixou de ser "maior" em
// zoom=200%, só o CSS `scale()` do `.world` deixa o CARD maior na tela.
// Âncora percentual sobrevive a qualquer fórmula de content-size futura:
// o centro é sempre fração (0.5, 0.5), e ainda distingue claramente a
// versão com bug de coordenada (que mandava o clique pra METADE da
// posição real) da corrigida, porque o clique real é disparado a partir
// da fração medida no BOX VISUAL na tela (que o zoom sempre muda), não
// de um valor cravado.
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><head><title>antes</title></head><body style="margin:0;">
    <button id="btn" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:60px;height:30px;"
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

  const barCoords = await centerOf(page, '[data-role="browser-address"] input');
  await page.click(barCoords.x, barCoords.y);
  await page.evalJs(`
    (() => {
      const inp = document.querySelector('[data-role="browser-address"] input');
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

  // O botão é ancorado no centro exato do content space (ver comentário
  // acima) — sua fração é sempre (0.5, 0.5), não depende de ler o content
  // size real nem de recalcular nada.
  const targetFractionX = 0.5;
  const targetFractionY = 0.5;

  const canvasBox = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.card-frame[data-kind="browser"] canvas');
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
    `clique real em zoom=200% acerta o botão de verdade (canvas na tela ${JSON.stringify(canvasBox)}, clique em (${Math.round(clickX)},${Math.round(clickY)}), título real depois: ${titleAfterClick})`,
    titleAfterClick,
    "clicked-target",
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
