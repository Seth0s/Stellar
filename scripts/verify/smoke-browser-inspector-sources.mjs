// DESIGN-BACKLOG.md §2.1 item 7 (2026-09-07) — aba Sources, do zero (não
// existia nada antes). Fixture real serve um documento HTML, um script
// externo e uma folha de estilo externa, cada um com um marcador único
// no conteúdo real — prova que a lista lê o DOM de verdade (document.
// scripts/styleSheets) e que o CONTEÚDO vem de um fetch real no processo
// main (`session.fetch`, ver browser-registry.ts's `fetchSource`), não
// de `evalJs` (que estouraria o teto de truncamento pra um arquivo real)
// nem de um mock.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-sources-${CDP_PORT}`, import.meta.url).pathname;

const SCRIPT_MARKER = "STELLAR_SOURCES_SCRIPT_MARKER_" + Math.random().toString(36).slice(2);
const STYLE_MARKER_CLASS = "stellar-sources-style-marker";
const FIXTURE_HTML = `<!doctype html><html><head>
  <link rel="stylesheet" href="/style.css">
  <script src="/app.js"></script>
</head><body><h1>Fixture Sources</h1></body></html>`;
const FIXTURE_JS = `// ${SCRIPT_MARKER}\nconsole.log("loaded");\n`;
const FIXTURE_CSS = `.${STYLE_MARKER_CLASS} { color: red; }\n`;

const httpPort = await pickFreePort();
const server = createServer((req, res) => {
  if (req.url === "/app.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end(FIXTURE_JS);
  } else if (req.url === "/style.css") {
    res.writeHead(200, { "content-type": "text/css" });
    res.end(FIXTURE_CSS);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FIXTURE_HTML);
  }
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
  await bootIntoFreshSession(page, "Sources Teste", { spawnTerminal: false });
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

  const sourcesTab = await centerOf(page, '[data-role="inspector-tab"][data-tab="sources"]');
  await page.click(sourcesTab.x, sourcesTab.y);
  await new Promise((r) => setTimeout(r, 500));

  const items = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-role="inspector-source-item"]')].map((el) => ({ kind: el.getAttribute('data-kind'), title: el.getAttribute('title') })))
    `),
  );
  check("a lista mostra o documento principal (não só scripts)", items.some((i) => i.kind === "document"), true);
  check("...o script externo real da fixture (app.js, lido do document.scripts de verdade)", items.some((i) => i.kind === "script" && i.title.endsWith("/app.js")), true);
  check("...e a folha de estilo externa real (style.css, do document.styleSheets)", items.some((i) => i.kind === "stylesheet" && i.title.endsWith("/style.css")), true);

  const scriptItem = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('[data-role="inspector-source-item"]')].find((e) => e.getAttribute('title').endsWith('/app.js'));
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(scriptItem.x, scriptItem.y);
  await new Promise((r) => setTimeout(r, 600));

  check(
    "a nota de breakpoints desabilitados aparece SEMPRE que um arquivo está aberto",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-breakpoint-notice"]')`),
    true,
  );

  const editorText = await page.evalJs(`document.querySelector('[data-role="inspector-source-viewer"] .cm-content')?.textContent ?? ''`);
  check("o conteúdo REAL do app.js (marcador único) aparece no visualizador — não um mock/placeholder", editorText.includes(SCRIPT_MARKER), true);

  // O editor tem que ser genuinamente read-only — não só um `onChange`
  // que descarta silenciosamente: digitar não pode mudar o documento do
  // CodeMirror.
  const cmContent = await centerOf(page, '[data-role="inspector-source-viewer"] .cm-content');
  await page.click(cmContent.x, cmContent.y);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: "X", key: "X", code: "KeyX" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", text: "X", key: "X", code: "KeyX" });
  await new Promise((r) => setTimeout(r, 200));
  const editorTextAfterType = await page.evalJs(`document.querySelector('[data-role="inspector-source-viewer"] .cm-content')?.textContent ?? ''`);
  check("...e digitar de verdade NÃO muda o documento (readOnly de verdade, não só onChange descartado)", editorTextAfterType, editorText);

  // Troca pra CSS e confirma que troca de arquivo funciona (não fica
  // preso mostrando sempre o primeiro selecionado).
  const styleItem = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('[data-role="inspector-source-item"]')].find((e) => e.getAttribute('title').endsWith('/style.css'));
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(styleItem.x, styleItem.y);
  await new Promise((r) => setTimeout(r, 600));
  const cssText = await page.evalJs(`document.querySelector('[data-role="inspector-source-viewer"] .cm-content')?.textContent ?? ''`);
  check("trocar de arquivo na lista mostra o conteúdo REAL do outro arquivo (style.css)", cssText.includes(STYLE_MARKER_CLASS), true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
