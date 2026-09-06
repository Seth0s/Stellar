// Pendentes #188 — "Menu de contexto nativo do Chromium no browser
// embutido". Um Menu nativo de verdade (Electron.Menu.popup) não é DOM —
// não dá pra clicar nos ITENS via CDP contra o alvo do renderer (o menu é
// um widget do SO, fora desse alvo). O que dá pra verificar de ponta a
// ponta sem gambiarra: um botão direito REAL sobre a página embutida
// (não sintetizado — forwardado pelo mesmo pipeline de sempre,
// `onCanvasPointerDown`/`Up`) faz o Chromium OFFSCREEN disparar seu
// próprio evento `context-menu`, que main/browser-registry.ts encaminha
// pro renderer com os params certos (linkURL sobre um link, isEditable
// sobre um input, nada sobre fundo vazio) — e que o handler real
// (`browser:show-context-menu`) processa sem derrubar o app.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-context-menu-${CDP_PORT}`, import.meta.url).pathname;

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

// Posições fixas em PORCENTAGEM do viewport da página embutida — não
// preciso saber o `contentSizeRef`/factor reais (BrowserCard.tsx) pra
// converter: como o espaço de conteúdo é só uma versão uniformemente
// escalada do retângulo real do canvas, a MESMA fração (ex.: 25% da
// largura) cai no mesmo ponto relativo dos dois lados — dá pra calcular
// a coordenada de tela real direto a partir do bbox do canvas.
const FIXTURE_HTML = `<!doctype html><html><body style="margin:0;background:#fff">
  <a id="lnk" href="https://example.com/target-link-xyz" style="position:fixed;left:10%;top:10%;width:30%;height:10%;display:block;">link</a>
  <input id="inp" value="hello world" style="position:fixed;left:10%;top:40%;width:30%;height:10%;">
  <div id="plain" style="position:fixed;left:10%;top:70%;width:30%;height:10%;">plain area</div>
</body></html>`;

const httpPort = await pickFreePort();
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${httpPort}/`;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Context Menu Teste");
  await new Promise((r) => setTimeout(r, 500));

  const addBtn = await centerOf(page, '[data-role="rail-add-card"]');
  await page.click(addBtn.x, addBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const browserBtn = await centerOf(page, '.popover-row[data-kind="browser"]');
  await page.click(browserBtn.x, browserBtn.y);
  await new Promise((r) => setTimeout(r, 700));

  const browserId = JSON.parse(
    await page.evalJs(
      `window.store.boards.list().then((b) => window.store.list(b[0].id)).then((cards) => JSON.stringify(cards.find((c) => c.kind === 'browser').id))`,
    ),
  );
  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 700));

  // Grava todo `context-menu` que chegar pro card certo — a mesma API
  // pública que BrowserCard.tsx já usa em produção, só mais um listener.
  await page.evalJs(`
    window.__ctxParams = [];
    window.__offCtx = window.browser.onContextMenu((id, params) => {
      if (id === ${JSON.stringify(browserId)}) window.__ctxParams.push(params);
    });
    'ok';
  `);

  async function canvasBox() {
    return JSON.parse(
      await page.evalJs(`
        (() => {
          const canvas = document.querySelector('[data-role="browser-body"]');
          if (!canvas) return JSON.stringify(null);
          const r = canvas.getBoundingClientRect();
          return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height });
        })()
      `),
    );
  }

  async function rightClickFraction(fx, fy) {
    const box = await canvasBox();
    if (!box) throw new Error("browser canvas not found");
    const x = box.left + fx * box.width;
    const y = box.top + fy * box.height;
    await page.click(x, y, "right");
    await new Promise((r) => setTimeout(r, 500));
  }

  async function lastParams() {
    return JSON.parse(await page.evalJs(`JSON.stringify(window.__ctxParams[window.__ctxParams.length - 1] ?? null)`));
  }

  // 1. Botão direito sobre o link — linkURL deve vir preenchido, não
  //    editável.
  await rightClickFraction(0.25, 0.15);
  const overLink = await lastParams();
  console.log("DEBUG overLink:", JSON.stringify(overLink));
  check("botão direito real sobre um link chega no renderer com o context-menu real do Chromium", !!overLink, true);
  check("...com o linkURL certo (não é sintetizado, veio do próprio Chromium offscreen)", overLink?.linkURL, "https://example.com/target-link-xyz");
  check("...e isEditable falso (não é um campo de texto)", overLink?.isEditable, false);

  // 2. Botão direito sobre o <input> — isEditable true, sem linkURL.
  await rightClickFraction(0.25, 0.45);
  const overInput = await lastParams();
  console.log("DEBUG overInput:", JSON.stringify(overInput));
  check("botão direito sobre um <input> chega com isEditable true", overInput?.isEditable, true);
  check("...e sem linkURL (não é um link)", overInput?.linkURL, "");

  // 3. Botão direito em área vazia — nem link nem editável.
  await rightClickFraction(0.25, 0.75);
  const overPlain = await lastParams();
  console.log("DEBUG overPlain:", JSON.stringify(overPlain));
  check("botão direito em área vazia chega sem linkURL", overPlain?.linkURL, "");
  check("...e sem isEditable", overPlain?.isEditable, false);
  check("...com canGoBack/canGoForward como booleanos reais (navigationHistory real, não um placeholder)", typeof overPlain?.canGoBack, "boolean");

  // A cada um dos 3 cliques acima, BrowserCard.tsx's próprio efeito de
  // produção TAMBÉM recebeu o evento e chamou showContextMenu de verdade
  // (main/index.ts monta o Menu e chama .popup() de verdade) — se esse
  // caminho tivesse uma exceção não tratada (template malformado, `win`
  // errado), o processo principal ficaria instável. Confirma que a
  // página embutida continua respondendo normalmente depois de tudo.
  const pageText = JSON.parse(
    await page.evalJs(`window.browser.getPageText(${JSON.stringify(browserId)}).then((r) => JSON.stringify(r))`),
  );
  check("depois dos 3 menus reais (link/input/vazio), a página embutida continua respondendo (main não travou)", pageText.ok, true);

  await page.evalJs(`window.__offCtx?.(); 'ok';`);
  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
