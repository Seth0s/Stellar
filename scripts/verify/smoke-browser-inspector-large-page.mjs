// Pendentes #188 — bug real reportado pelo usuário com screenshot: a aba
// Elements mostrava "Não foi possível ler a página" em google.com, mas
// funcionava nas fixtures pequenas de todo outro smoke test deste
// diretório. Causa raiz original: `SNAPSHOT_SCRIPT` (BrowserInspector.tsx)
// serializava a árvore inteira sem orçamento total de nós — uma página
// real densa o bastante estourava `MAX_EVAL_RESULT_CHARS` (20_000, `evalJs`
// em browser-registry.ts), o resultado vinha truncado no meio, `JSON.parse`
// falhava em silêncio (`evalJson`) e a UI mostrava "não foi possível ler"
// pra QUALQUER site denso o bastante — sem nunca dizer por quê.
//
// DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 1) resolveu isso na raiz: a
// árvore usa `DOM.getDocument`/`DOM.requestChildNodes` — cada nível chega
// de cada vez, direto do protocolo de depuração, sem NUNCA fazer round-trip
// do subtree inteiro como blob JSON. Não existe mais orçamento de nó/
// truncamento nenhum pra impor (`SNAPSHOT_NODE_BUDGET` foi deletado, não
// repropositado) — este teste virou o OPOSTO do original: prova que uma
// página densa (300 linhas sintéticas) expande e revela TODOS os nós reais,
// sem nenhum aviso de truncamento (que não existe mais na UI).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-large-page-${CDP_PORT}`, import.meta.url).pathname;

let rows = "";
for (let i = 0; i < 300; i++) {
  rows += `<li class="result-row result-row-${i}" data-index="${i}" data-testid="row-${i}"><a href="https://example.com/item/${i}" class="result-link">Resultado número ${i} com um título de tamanho razoável pra simular conteúdo real</a><span class="meta">meta-${i}</span></li>`;
}
const FIXTURE_HTML = `<!doctype html><html><head><title>Fixture pesada</title></head><body>
  <header class="site-header"><nav class="nav"><a href="#">Home</a><a href="#">Sobre</a><a href="#">Contato</a></nav></header>
  <main><ul class="results">${rows}</ul></main>
  <footer class="site-footer"><p>rodapé</p></footer>
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
  await bootIntoFreshSession(page, "Inspector Large Page Teste", { spawnTerminal: false });
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
  await new Promise((r) => setTimeout(r, 700));

  check(
    "página densa (300 linhas sintéticas) carrega a árvore de verdade, não 'não foi possível ler'",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-tree-line"]')`),
    true,
  );

  // Expande body -> main -> ul, revelando as 300 <li> reais de uma vez
  // (`DOM.requestChildNodes({nodeId, depth:1})` num nó com 300 filhos —
  // sem orçamento nenhum imposto pelo Inspector, o CDP entrega os 300).
  async function expandByTag(tag) {
    await page.evalJs(`
      (() => {
        const lines = [...document.querySelectorAll('[data-role="inspector-tree-line"]')];
        const line = lines.find((l) => l.getAttribute('data-tag') === ${JSON.stringify(tag)});
        const toggle = line && line.querySelector('button');
        if (toggle) toggle.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 400));
  }
  await expandByTag("body");
  await expandByTag("main");
  await expandByTag("ul");
  await new Promise((r) => setTimeout(r, 400));

  const liCount = await page.evalJs(`[...document.querySelectorAll('[data-role="inspector-tree-line"]')].filter((l) => l.getAttribute('data-tag') === 'li').length`);
  check("expandir <ul> revela TODAS as 300 <li> reais, sem truncar (sem orçamento de nó imposto)", Number(liCount), 300);

  check(
    "não existe mais aviso de truncamento nenhum na UI (o mecanismo foi removido, não só desativado)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-tree-truncated"]')`),
    false,
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
