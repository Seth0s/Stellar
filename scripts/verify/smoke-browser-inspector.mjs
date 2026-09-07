// Pendentes #188 — mini-inspector embutido no browser card. DevTools
// real só sabe abrir numa janela separada (offscreen não pinta a UI do
// DevTools — Electron não suporta) e não tinha "modo responsivo" de
// verdade nem atalho de botão direito, usuário pediu (com screenshot ao
// vivo) algo embutido no PRÓPRIO card. Este teste cobre as 3 abas
// (Elements/Console/Responsivo), todas construídas em cima de `evalJs`
// (já existia só pro lado MCP) + um `setDeviceEmulation` novo — sem
// CDP/`webContents.debugger`.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-${CDP_PORT}`, import.meta.url).pathname;

const FIXTURE_HTML = `<!doctype html><html><body style="margin:0">
  <h1 id="title">Fixture da prova</h1>
  <button id="btn" style="outline-color: rgb(11, 22, 33)">clique aqui</button>
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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Inspector Teste", { spawnTerminal: false });
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

  // Abre pelo kebab menu ("Abrir inspector") — sem elemento pré-focado.
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
  check("botão 'Abrir inspector' existe no menu kebab do browser card", inspectorBtn !== null, true);
  await page.click(inspectorBtn.x, inspectorBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  check("o drawer do inspector embutido aparece dentro do card (não janela nova)", await page.evalJs(`!!document.querySelector('[data-role="browser-inspector"]')`), true);

  // --- Elements ---
  await new Promise((r) => setTimeout(r, 500)); // tempo pro snapshot inicial (evalJs) resolver
  const treeInfo = JSON.parse(
    await page.evalJs(`
      (() => {
        const lines = [...document.querySelectorAll('[data-role="inspector-tree-line"]')];
        return JSON.stringify({ count: lines.length, tags: lines.map((l) => l.getAttribute('data-tag')) });
      })()
    `),
  );
  check("aba Elements carrega uma árvore real da página embutida (não vazia)", treeInfo.count > 0, true);
  check("...e a raiz é <html> (serializado de verdade, não um mock)", treeInfo.tags[0], "html");

  // Expande até achar o <button id="btn"> e clica pra selecionar/destacar.
  async function expandAll() {
    for (let i = 0; i < 6; i++) {
      await page.evalJs(`
        (() => {
          const toggles = [...document.querySelectorAll('[data-role="inspector-tree-line"]')]
            .filter((l) => l.nextElementSibling === null || true)
            .map((l) => l.querySelector('button'));
          for (const t of toggles) if (t) t.click();
        })()
      `);
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  await expandAll();

  const btnNode = JSON.parse(
    await page.evalJs(`
      (() => {
        const line = [...document.querySelectorAll('[data-role="inspector-tree-line"]')].find((l) => l.textContent.includes('btn'));
        if (!line) return JSON.stringify(null);
        const r = line.getBoundingClientRect();
        return JSON.stringify({ x: r.x + 10, y: r.y + r.height / 2 });
      })()
    `),
  );
  check("a árvore expandida acha o <button id=\"btn\"> real da página", btnNode !== null, true);
  if (btnNode) {
    await page.click(btnNode.x, btnNode.y);
    await new Promise((r) => setTimeout(r, 400));
    // DESIGN-BACKLOG.md §2.1 (adoção de CDP) trocou o destaque por
    // `Overlay.highlightNode` (Fase 1) — pinta FORA do DOM/CSSOM da página
    // (não é mais um atributo observável via `document.querySelector`,
    // estritamente melhor). A ponte `data-stellar-el-id` que existia como
    // sinal observável de reposição foi removida de vez na Fase 2/3 (Styles
    // e Listeners migraram pra usar o `nodeId` do CDP direto, sem
    // atributo nenhum) — o sinal que sobra e prova que a seleção identificou
    // o elemento CERTO na página real é o próprio painel Styles refletindo
    // o `outline-color` único da fixture (`rgb(11, 22, 33)`, não uma cor
    // que qualquer outro elemento da página teria).
    const stylesTab = await centerOf(page, '[data-role="inspector-subtab"][data-sub="styles"]');
    await page.click(stylesTab.x, stylesTab.y);
    await new Promise((r) => setTimeout(r, 300));
    const stylesText = await page.evalJs(`document.querySelector('[data-role="inspector-subpanel"]')?.textContent ?? ""`);
    check("clicar no nó da árvore seleciona o elemento DE VERDADE na página embutida (Styles mostra o outline-color único do #btn)", stylesText.includes("rgb(11, 22, 33)"), true);
  }

  // --- Console ---
  const consoleTab = await centerOf(page, '[data-role="inspector-tab"][data-tab="console"]');
  await page.click(consoleTab.x, consoleTab.y);
  await new Promise((r) => setTimeout(r, 200));
  const consoleInput = await centerOf(page, '[data-role="inspector-console-input"]');
  await page.click(consoleInput.x, consoleInput.y);
  await page.evalJs(`
    (() => {
      const input = document.querySelector('[data-role="inspector-console-input"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '21 * 2');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  const consoleSubmit = await centerOf(page, '[data-role="inspector-console-submit"]');
  await page.click(consoleSubmit.x, consoleSubmit.y);
  await new Promise((r) => setTimeout(r, 400));
  const consoleResult = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-role="inspector-console-line"]')].map((l) => ({ level: l.getAttribute('data-level'), text: l.textContent })))
    `),
  );
  check("console eval real: '21 * 2' produz um resultado com 42", consoleResult.some((l) => l.level === "result" && l.text.includes("42")), true);

  // --- Device toolbar (não é mais uma aba — pedido direto do usuário,
  // "e não tab" — mas também não fica mais sempre visível: DESIGN-
  // BACKLOG.md §2.1 item 4, decisão do usuário, escondida por padrão
  // atrás de um toggle no address bar, ícone de celular, igual o
  // protótipo) ---
  check(
    "a barra de dispositivo NÃO aparece antes de clicar no toggle (escondida por padrão, item 4)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar"]')`),
    false,
  );
  const widthBeforeToolbar = JSON.parse(
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.innerWidth").then((r) => JSON.stringify(r))`),
  );

  const deviceToggle = await centerOf(page, '[data-role="inspector-device-toolbar-toggle"]');
  await page.click(deviceToggle.x, deviceToggle.y);
  await new Promise((r) => setTimeout(r, 500));
  check(
    "clicar no ícone do inspector revela a barra de dispositivo",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar"]')`),
    true,
  );

  // DESIGN-BACKLOG.md §2.1 (revisto ao vivo 2026-09-07, pedido do
  // usuário: "foi preciso clicar em algum preset em vez de já aplicar os
  // frames") — abrir a barra já aplica o preset Mobile sozinho, sem
  // exigir escolha manual no dropdown.
  const widthAfterOpen = JSON.parse(
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.innerWidth").then((r) => JSON.stringify(r))`),
  );
  check("abrir a barra de dispositivo JÁ aplica o preset Mobile sozinho (innerWidth REAL vira 390 sem escolher nada)", widthAfterOpen.result, "390");
  check("...e era diferente de 390 antes de abrir a barra", widthBeforeToolbar.result !== "390", true);

  // Trocar pra um preset DIFERENTE ainda deve funcionar via o dropdown
  // normalmente (cobertura da seleção manual, não só do auto-apply).
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-device-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'Tablet (768×1024)');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  const widthAfterTablet = JSON.parse(
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.innerWidth").then((r) => JSON.stringify(r))`),
  );
  check("trocar pro preset 'Tablet' pelo dropdown muda o innerWidth REAL pra 768", widthAfterTablet.result, "768");

  // Achado ao vivo (screenshot do usuário): com emulação ativa (o botão
  // "Parar emulação" aparece, deixando a barra mais cheia) e o painel na
  // largura mínima, os controles do device toolbar (DPR/"Parar emulação")
  // cortavam/quebravam linha dentro do próprio botão em vez de simplesmente
  // não caber. Encolhe o painel pro `DOCK_MIN` real e confirma que a barra
  // ROLA (overflow real, `scrollWidth > clientWidth`) sem nenhum controle
  // quebrando texto internamente.
  const handle = await centerOf(page, '[data-role="inspector-resize-handle"]');
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + 400, y: handle.y, button: "left", pointerType: "mouse" });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x + 400, y: handle.y, button: "left", clickCount: 1, pointerType: "mouse" });
  await new Promise((r) => setTimeout(r, 300));
  const toolbarMeasure = JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        overflowing: document.querySelector('[data-role="inspector-device-toolbar"]').scrollWidth > document.querySelector('[data-role="inspector-device-toolbar"]').clientWidth,
        anyWrapped: [...document.querySelectorAll('[data-role="inspector-device-toolbar"] button, [data-role="inspector-device-toolbar"] select')].some((el) => el.scrollHeight > el.clientHeight + 2),
      })
    `),
  );
  check("device toolbar cheio (emulação ativa) num painel estreito ROLA de verdade, não corta escondido", toolbarMeasure.overflowing, true);
  check("...e nenhum controle quebra texto internamente (DPR/'Parar emulação' mantêm o tamanho natural)", toolbarMeasure.anyWrapped, false);

  // Fecha o inspector — a emulação de dispositivo deve desligar sozinha
  // (não pode deixar a página presa em viewport mobile sem controle
  // nenhum visível pra desligar). Painel acabou de ser espremido pro
  // `DOCK_MIN` (acima) com emulação ativa — o dock agora encolhe de
  // VERDADE sob aperto (refactor overlay→reflow), então o botão de
  // fechar pode estar rolado pra fora da área visível de
  // `.inspectorTabs` (`overflow-x:auto`); `scrollIntoView` simula o
  // gesto de rolar até ele, igual um usuário real precisaria fazer.
  const closeBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = document.querySelector('[data-role="browser-inspector"] button[title="Fechar inspector"]');
        b.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));
  const widthAfterClose = JSON.parse(
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.innerWidth").then((r) => JSON.stringify(r))`),
  );
  check("fechar o inspector desliga a emulação de dispositivo sozinho", widthAfterClose.result !== "768", true);
  check("o drawer some do DOM depois de fechado", await page.evalJs(`!document.querySelector('[data-role="browser-inspector"]')`), true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
