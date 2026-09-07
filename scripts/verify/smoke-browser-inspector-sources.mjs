// DESIGN-BACKLOG.md §2.1 item 7 (2026-09-07) — aba Sources, do zero (não
// existia nada antes). Fixture real serve um documento HTML, um script
// externo e uma folha de estilo externa, cada um com um marcador único
// no conteúdo real — prova que a lista lê o DOM de verdade (document.
// scripts/styleSheets) e que o CONTEÚDO vem de um fetch real no processo
// main (`session.fetch`, ver browser-registry.ts's `fetchSource`), não
// de `evalJs` (que estouraria o teto de truncamento pra um arquivo real)
// nem de um mock.
//
// DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 6, 2026-09-07) — o gutter
// de breakpoint (antes permanentemente desabilitado, nota fixa em
// qualquer arquivo aberto) vira real via Debugger.setBreakpointByUrl/
// removeBreakpoint: este teste clica no gutter de uma linha de JS de
// verdade e confirma que o marcador aparece/some ao alternar, e que
// style.css (não é JS) continua mostrando a nota de escopo em vez do
// gutter.
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

// Sonda em vez de dormir uma vez só — `fetchSource` é um fetch de
// verdade no main process, tempo variável sob carga (ver uso abaixo).
async function waitForContentIncluding(page, needle, { timeoutMs = 4000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await page.evalJs(`document.querySelector('[data-role="inspector-source-viewer"] .cm-content')?.textContent ?? ''`);
    if (last.includes(needle)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

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
    "num arquivo JS de verdade, NÃO aparece a nota de 'só em JS' (é exatamente um arquivo JS)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-breakpoint-notice"]')`),
    false,
  );

  // --- Breakpoint real no gutter (Fase 6, adoção de CDP) ---
  // Sonda (não uma espera fixa) — o conteúdo do arquivo (`fetchSource`,
  // fetch de verdade no main process) pode ainda não ter chegado logo
  // depois do clique no item da lista.
  async function gutterClickPointForLine(needle, { timeoutMs = 4000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const point = JSON.parse(
        await page.evalJs(`
          (() => {
            const gutter = document.querySelector('.cm-breakpoint-gutter');
            const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes(${JSON.stringify(needle)}));
            if (!gutter || !line) return JSON.stringify(null);
            const gr = gutter.getBoundingClientRect();
            const lr = line.getBoundingClientRect();
            return JSON.stringify({ x: gr.x + gr.width / 2, y: lr.y + lr.height / 2 });
          })()
        `),
      );
      if (point) return point;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }
  const gutterPoint = await gutterClickPointForLine("console.log");
  check("o gutter de breakpoint existe no visualizador de um arquivo JS", gutterPoint !== null, true);
  await page.click(gutterPoint.x, gutterPoint.y);
  await new Promise((r) => setTimeout(r, 400));
  check(
    "clicar no gutter cria um breakpoint DE VERDADE (Debugger.setBreakpointByUrl, marcador visível aparece)",
    await page.evalJs(`!!document.querySelector('.cm-breakpoint-marker')`),
    true,
  );
  await page.click(gutterPoint.x, gutterPoint.y);
  await new Promise((r) => setTimeout(r, 400));
  check(
    "clicar de novo remove o breakpoint DE VERDADE (Debugger.removeBreakpoint, marcador some)",
    await page.evalJs(`!!document.querySelector('.cm-breakpoint-marker')`),
    false,
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

  // --- Pausar de verdade num breakpoint (o ciclo completo da Fase 6) ---
  // Continua no MESMO app.js (nunca troca de arquivo até aqui) — marca o
  // breakpoint de novo (desta vez sem desfazer) e recarrega a página:
  // reexecuta o script, bate no breakpoint, e Debugger.paused deveria
  // chegar de verdade.
  await page.click(gutterPoint.x, gutterPoint.y);
  await new Promise((r) => setTimeout(r, 400));
  check("breakpoint marcado de novo antes de recarregar", await page.evalJs(`!!document.querySelector('.cm-breakpoint-marker')`), true);

  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(fixtureUrl)})`);
  await new Promise((r) => setTimeout(r, 1000));
  check(
    "recarregar a página com o breakpoint ativo pausa a execução DE VERDADE (Debugger.paused real)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-debugger-paused"]')`),
    true,
  );

  const resumeBtn = await centerOf(page, '[data-role="inspector-debugger-paused"] button');
  await page.click(resumeBtn.x, resumeBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  check(
    "clicar 'Continuar' resume a execução de verdade (Debugger.resume, o banner de pausa some)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-debugger-paused"]')`),
    false,
  );

  // --- Troca pra CSS por último (flake pré-existente documentado nesta
  // troca de arquivo — isolado no FIM da suíte de propósito, pra não
  // arriscar cascatear numa checagem de outra coisa se ela flacar). ---
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
  await new Promise((r) => setTimeout(r, 300));
  const cssText = await waitForContentIncluding(page, STYLE_MARKER_CLASS);
  check("trocar de arquivo na lista mostra o conteúdo REAL do outro arquivo (style.css)", cssText.includes(STYLE_MARKER_CLASS), true);

  check(
    "style.css NÃO é JS — mostra a nota de escopo em vez do gutter de breakpoint",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-breakpoint-notice"]')`),
    true,
  );
  check("...e de fato não existe gutter de breakpoint nenhum nesse arquivo (não é JS)", await page.evalJs(`!!document.querySelector('.cm-breakpoint-gutter')`), false);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
