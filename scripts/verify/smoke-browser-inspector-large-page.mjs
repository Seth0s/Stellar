// Pendentes #188 — bug real reportado pelo usuário com screenshot: a aba
// Elements mostrava "Não foi possível ler a página" em google.com, mas
// funcionava nas fixtures pequenas de todo outro smoke test deste
// diretório. Causa raiz confirmada com instrumentação real (não só
// suspeita): `SNAPSHOT_SCRIPT` (BrowserInspector.tsx) serializava a
// árvore inteira sem orçamento total de nós — uma página real densa o
// bastante estourava `MAX_EVAL_RESULT_CHARS` (20_000, `evalJs` em
// browser-registry.ts), o resultado vinha truncado no meio, `JSON.parse`
// falhava em silêncio (`evalJson`) e a UI mostrava "não foi possível
// ler" pra QUALQUER site denso o bastante — sem nunca dizer por quê.
//
// Este teste usa uma fixture SINTÉTICA pesada (não depende de internet
// real, ao contrário da investigação original que testou contra
// google.com/wikipedia ao vivo pra calibrar o orçamento de 60 nós) —
// determinístico pra CI, reproduz a mesma classe de página densa.
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
const SMALL_HTML = `<!doctype html><html><body><h1>Fixture pequena</h1><p>Só um parágrafo.</p></body></html>`;
const httpPort = await pickFreePort();
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url === "/small" ? SMALL_HTML : FIXTURE_HTML);
});
await new Promise((resolve) => server.listen(httpPort, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${httpPort}/`;
const smallUrl = `http://127.0.0.1:${httpPort}/small`;

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
  check(
    "...e avisa honestamente que truncou, em vez de simplesmente mostrar uma árvore incompleta calada",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-tree-truncated"]')`),
    true,
  );

  // Uma página pequena (as fixtures de todo outro smoke test deste
  // diretório) não deve mostrar o aviso — só dispara quando de verdade
  // bate no orçamento de nós. Navegar de novo NO MESMO card/inspector
  // também prova que `treeTruncated` reresseta a cada `refreshTree()`,
  // não fica preso em `true` pra sempre depois da 1ª página densa.
  await page.evalJs(`window.browser.navigate(${JSON.stringify(browserId)}, ${JSON.stringify(smallUrl)})`);
  await new Promise((r) => setTimeout(r, 800));
  const reloadBtn = await centerOf(page, '[data-role="browser-inspector"] button[title="Atualizar árvore"]');
  await page.click(reloadBtn.x, reloadBtn.y);
  await new Promise((r) => setTimeout(r, 500));
  check(
    "página pequena não mostra o aviso de truncamento (só dispara quando bate no orçamento de verdade)",
    await page.evalJs(`!document.querySelector('[data-role="inspector-tree-truncated"]')`),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
