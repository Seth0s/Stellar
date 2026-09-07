// DESIGN-BACKLOG.md §2.1 item 3 — "modelo de device frame" (2026-09-07).
// Antes deste fix, ligar emulação de dispositivo mudava o content size
// REAL do webContents (ex: 390×844 pro preset Mobile) mas o <canvas> do
// BrowserCard.tsx continuava esticado width:100%/height:100% pro tamanho
// do card inteiro — a proporção real do dispositivo ficava forçada num
// retângulo com proporção bem diferente, distorcendo a página inteira
// (confirmado ao vivo com uma fixture de teste virando um borrão vertical
// esticado). Junto, achado no MESMO trabalho: `contentSizeRef` (mapeamento
// de clique em BrowserCard.tsx) nunca era atualizado por
// `setDeviceEmulation` (só por `applyResize`, que a emulação não passa
// por) — cliques durante emulação (e depois de desligá-la) usavam o
// tamanho de conteúdo ERRADO. E, no meio do próprio trabalho de corrigir
// isto: o dock do inspector é um overlay ABSOLUTO por cima do canvas (de
// propósito, não reflow) — centralizar o device-frame contra a largura
// CHEIA do corpo do card o fazia cair ATRÁS do próprio painel que o abriu
// (achado ao vivo comparando `getBoundingClientRect()` real com um
// screenshot — o frame existia, na proporção certa, mas invisível).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-device-frame-${CDP_PORT}`, import.meta.url).pathname;

// Botão cobrindo a página inteira (detecta "chegou algum clique") + um
// marcador pequeno EXATAMENTE no centro do viewport 390×844 do preset
// Mobile (detecta "o clique chegou nas COORDENADAS certas", não só em
// algum lugar da página) — o teste real do bug de `contentSizeRef` stale.
const FIXTURE_HTML = `<!doctype html><html><body style="margin:0" onclick="window.__bodyClicked=true">
  <div id="marker" style="position:absolute;left:calc(50% - 10px);top:calc(50% - 10px);width:20px;height:20px;background:#0f0"
       onclick="event.stopPropagation();window.__markerClicked=true"></div>
</body></html>`;
const httpPort = await pickFreePort();
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

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
  if (!res) throw new Error(`element not found: ${selector}`);
  return res;
}

async function canvasRect(page) {
  return JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('[data-role="browser-body"]').getBoundingClientRect())`));
}

async function wrapMeasure(page) {
  return JSON.parse(
    await page.evalJs(`
      JSON.stringify((() => {
        const wrap = document.querySelector('[data-role="browser-body"]').parentElement;
        return { sw: wrap.scrollWidth, sh: wrap.scrollHeight, cw: wrap.clientWidth, ch: wrap.clientHeight };
      })())
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Device Frame Teste", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  const addBtn = await centerOf(page, '[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf(page, '.popover-row[data-kind="browser"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 700));

  const browserId = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((b) => window.store.list(b[0].id)).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'browser').id))`),
  );
  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 700));

  const kebab = await centerOf(page, '[data-role="browser-address"] button[title="Mais opções"]');
  await page.click(kebab.x, kebab.y);
  await new Promise((r) => setTimeout(r, 300));
  const inspectorBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-menu"] button')].find((x) => x.textContent.includes('Abrir inspector'));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(inspectorBtn.x, inspectorBtn.y);
  await new Promise((r) => setTimeout(r, 500));

  check("sem emulação ativa, o seletor de zoom nem aparece (só faz sentido com um device-frame de verdade)", await page.evalJs(`!!document.querySelector('[data-role="inspector-zoom-select"]')`), false);

  // Item 4 — a barra de dispositivo agora fica escondida por padrão atrás
  // de um toggle no address bar (ícone de celular), não mais sempre visível.
  const deviceToggle = await centerOf(page, '[data-role="inspector-device-toolbar-toggle"]');
  await page.click(deviceToggle.x, deviceToggle.y);
  await new Promise((r) => setTimeout(r, 300));

  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-device-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'Mobile (390×844)');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 600));

  check("com emulação ativa, o seletor de zoom aparece no device toolbar", await page.evalJs(`!!document.querySelector('[data-role="inspector-zoom-select"]')`), true);

  const rect = await canvasRect(page);
  const ratio = rect.width / rect.height;
  const deviceRatio = 390 / 844;
  check(
    "device-frame (zoom 'Ajustar', dock à direita) preserva a proporção REAL do dispositivo, não esticado pro card inteiro",
    Math.abs(ratio - deviceRatio) < 0.02,
    true,
  );

  const dockRight = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelector('[data-role="browser-inspector"]').getBoundingClientRect())`));
  check("...e o frame não fica escondido ATRÁS do painel do dock (dock é overlay absoluto, não reflow)", rect.right <= dockRight.left + 1, true);

  // Clique no CENTRO exato da caixa do canvas — se `contentSizeRef` (o
  // mapeamento clique→conteúdo em BrowserCard.tsx) estivesse desatualizado
  // (usando o tamanho de mundo do card em vez do content size real da
  // emulação, 390×844), este clique cairia fora do marcador de 20×20 no
  // centro exato do viewport emulado.
  await page.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await new Promise((r) => setTimeout(r, 300));
  const clickResult = JSON.parse(
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "({ marker: !!window.__markerClicked, body: !!window.__bodyClicked })").then((r) => JSON.stringify(r))`),
  );
  const clicked = JSON.parse(clickResult.result);
  check(
    "clique no centro do device-frame chega nas coordenadas CERTAS da página emulada (mapeamento não fica desatualizado)",
    clicked.marker,
    true,
  );

  // Move o dock pra baixo — área disponível vira larga/achatada; um celular
  // em pé precisa sobrar espaço escuro (--ink) dos dois lados, não esticar
  // pra preencher a largura toda.
  const dockBottomBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-inspector"] button')].find((x) => x.title && x.title.toLowerCase().includes('baixo'));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  check("existe um botão pra dockar embaixo (necessário pra testar letterboxing horizontal)", dockBottomBtn !== null, true);
  if (dockBottomBtn) {
    await page.click(dockBottomBtn.x, dockBottomBtn.y);
    await new Promise((r) => setTimeout(r, 400));
    const rectBottom = await canvasRect(page);
    const ratioBottom = rectBottom.width / rectBottom.height;
    check(
      "com o dock embaixo (área larga/achatada), o frame de um celular em pé continua na proporção certa (sobra letterbox escuro dos lados, não estica)",
      Math.abs(ratioBottom - deviceRatio) < 0.02,
      true,
    );
  }

  // Zoom 100% — o frame passa a ter o tamanho REAL (390×844 CSS px), que
  // não cabe mais na área disponível: rolagem de verdade é o comportamento
  // CERTO aqui (bem diferente do bug antigo de esticar/distorcer).
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-zoom-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, '1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  const zoomedRect = await canvasRect(page);
  check("zoom 100% mostra o frame no tamanho REAL do dispositivo (390 CSS px de largura), não mais escalado", Math.round(zoomedRect.width), 390);
  const wrapAt100 = await wrapMeasure(page);
  check("...e a área rola de verdade quando o frame no tamanho real não cabe (scrollHeight > clientHeight)", wrapAt100.sh > wrapAt100.ch, true);

  // Volta pro 'Ajustar' — a rolagem forçada deve sumir nessa dimensão.
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-zoom-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'fit');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  const wrapAtFit = await wrapMeasure(page);
  check("...voltando pra 'Ajustar', a rolagem forçada some (o frame volta a caber sem cortar)", wrapAtFit.sh <= wrapAtFit.ch + 1, true);

  // Desliga a emulação — o canvas deve voltar a esticar 100%/100% (mesmo
  // comportamento de sempre fora de emulação), sem sobra de padding/dock-
  // avoidance nem fundo escuro grudados.
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-device-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'none');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  check(
    "desligar a emulação remove o data-emulating do wrap (canvas volta a esticar pro corpo inteiro do card)",
    await page.evalJs(`document.querySelector('[data-role="browser-body"]').parentElement.getAttribute('data-emulating')`),
    null,
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
