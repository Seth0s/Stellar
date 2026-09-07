// Pendentes #188 — painel de detalhes Styles/Computed do Elements (pedido
// direto do usuário depois de aprovar o protótipo: "Add the Elements
// Styles/Computed details pane next"). Sem CDP/`getMatchedCSSRules` (não
// existe mais no DOM padrão) — `elementStylesScript` (BrowserInspector.tsx)
// varre `document.styleSheets` de verdade + `getComputedStyle` real. Este
// teste prova que os dois painéis mostram dado genuíno da página embutida,
// não um mock: uma regra CSS externa de verdade (arquivo .css servido pelo
// fixture), um estilo inline de verdade, e uma propriedade computada real
// (incluindo o filtro de busca).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-styles-${CDP_PORT}`, import.meta.url).pathname;

const FIXTURE_HTML = `<!doctype html><html><head>
  <link rel="stylesheet" href="/style.css">
</head><body style="margin:0">
  <button id="btn" class="pick-me" style="margin-left: 7px">clique aqui</button>
</body></html>`;
const FIXTURE_CSS = `.pick-me { color: rgb(255, 0, 0); padding: 12px; }`;
const httpPort = await pickFreePort();
const server = createServer((req, res) => {
  if (req.url === "/style.css") {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(FIXTURE_CSS);
    return;
  }
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
  await bootIntoFreshSession(page, "Inspector Styles Teste", { spawnTerminal: false });
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
  await new Promise((r) => setTimeout(r, 800));

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

  check(
    "sem elemento selecionado, o painel de detalhes pede pra selecionar um (não mostra dado nenhum)",
    await page.evalJs(`document.querySelector('[data-role="inspector-subpanel"]')?.textContent.includes('Selecione um elemento')`),
    true,
  );

  // Expande a árvore até achar o <button> real e clica pra selecionar.
  for (let i = 0; i < 6; i++) {
    await page.evalJs(`
      (() => {
        for (const t of document.querySelectorAll('[data-role="inspector-tree-line"] button')) t.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 80));
  }
  const btnLine = JSON.parse(
    await page.evalJs(`
      (() => {
        const line = [...document.querySelectorAll('[data-role="inspector-tree-line"]')].find((l) => l.textContent.includes('btn'));
        if (!line) return JSON.stringify(null);
        const r = line.getBoundingClientRect();
        return JSON.stringify({ x: r.x + 10, y: r.y + r.height / 2 });
      })()
    `),
  );
  check("a árvore acha o <button id=\"btn\"> real da página", btnLine !== null, true);
  await page.click(btnLine.x, btnLine.y);
  await new Promise((r) => setTimeout(r, 500));

  const stylesText = await page.evalJs(`document.querySelector('[data-role="inspector-subpanel"]')?.textContent ?? ""`);
  check("Styles é a sub-aba padrão e já mostra o estilo INLINE real (margin-left: 7px)", stylesText.includes("margin-left") && stylesText.includes("7px"), true);
  check("...e a regra CSS EXTERNA de verdade (.pick-me, servida por style.css)", stylesText.includes(".pick-me") && stylesText.includes("style.css"), true);
  check("...com a declaração real dessa regra (color: rgb(255, 0, 0))", stylesText.includes("rgb(255, 0, 0)"), true);

  const computedTab = await centerOf(page, '[data-role="inspector-subtab"][data-sub="computed"]');
  await page.click(computedTab.x, computedTab.y);
  await new Promise((r) => setTimeout(r, 300));
  const computedText = await page.evalJs(`document.querySelector('[data-role="inspector-subpanel"]')?.textContent ?? ""`);
  check("Computed mostra getComputedStyle DE VERDADE (padding-top real: 12px, resolvido do shorthand)", computedText.includes("padding-top") && computedText.includes("12px"), true);
  check("...e o box model real (largura×altura do content box, não um placeholder)", await page.evalJs(`/\\d+ × \\d+/.test(document.querySelector('[data-role="inspector-box-content"]')?.textContent ?? "")`), true);

  const unfilteredCount = await page.evalJs(`document.querySelectorAll('[data-role="inspector-computed-list"] > div').length`);

  const filterInput = await centerOf(page, '[data-role="inspector-computed-filter"]');
  await page.click(filterInput.x, filterInput.y);
  await page.evalJs(`
    (() => {
      const input = document.querySelector('[data-role="inspector-computed-filter"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'padding-top');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  const filteredRows = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-computed-list"] > div')].map((d) => d.textContent))`),
  );
  // DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 2): `CSS.getComputedStyleForNode`
  // devolve TODAS as propriedades computadas reais (~460, sem allowlist
  // nenhuma) — inclui primas de mesmo prefixo como `scroll-padding-top`,
  // então filtrar por "padding-top" bate em mais de 1 linha de verdade
  // (comportamento correto do filtro por substring, não um bug). A
  // asserção certa não é mais "só 1 linha" e sim "toda linha mostrada
  // contém o termo, a linha exata `padding-top` está entre elas, e o
  // filtro de fato ESTREITA a lista" (prova que filtra de verdade, sem
  // assumir uma contagem total que depende da versão do Chrome).
  check("o filtro de propriedades computadas funciona de verdade (toda linha bate, padding-top está entre elas)", filteredRows.every((r) => r.includes("padding-top")) && filteredRows.some((r) => r.startsWith("padding-top")), true);
  check("...e o filtro de fato estreita a lista (menos linhas que a lista computada inteira)", filteredRows.length > 0 && filteredRows.length < unfilteredCount, true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
