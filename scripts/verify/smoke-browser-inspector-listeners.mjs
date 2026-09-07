// DESIGN-BACKLOG.md §2.1 item 6 (2026-09-07) — 3ª sub-aba do painel de
// detalhes do Elements (Styles/Computed já existiam, commit `4d995e0`).
// Sem `webContents.debugger`/CDP (decisão deste projeto), o único jeito
// honesto de ver handlers de FORA da página depois do fato é via
// propriedade IDL `on<evento>` do elemento — cobre atributo HTML
// (`onclick="..."`) e atribuição direta (`el.onclick = fn`), nunca
// `addEventListener`. Este teste usa uma fixture real com um handler de
// cada tipo (mais um elemento sem handler nenhum) pra provar que o painel
// reflete exatamente essa realidade, nota de escopo incluída — não uma
// lista inventada/mockada.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-listeners-${CDP_PORT}`, import.meta.url).pathname;

const FIXTURE_HTML = `<!doctype html><html><body style="margin:0">
  <button id="withAttr" onclick="void 0">via atributo</button>
  <button id="withProp">via propriedade</button>
  <button id="noHandler">sem handler</button>
  <script>document.querySelector('#withProp').onmouseenter = () => {};</script>
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

// `document.documentElement` já nasce auto-expandido (`refreshTree`), então
// só falta abrir o <body> uma vez pra revelar os 3 botões da fixture (que
// são folhas, sem toggle próprio) — clicar TODOS os toggles visíveis em
// loop, como outros testes fazem, oscila (cada clique em html/body alterna
// aberto↔fechado, período 4) e não converge de forma confiável pra uma
// fixture rasa como esta.
async function selectTreeNodeByText(page, needle) {
  await page.evalJs(`
    (() => {
      const lines = [...document.querySelectorAll('[data-role="inspector-tree-line"]')];
      const alreadyOpen = lines.some((l) => l.getAttribute('data-tag') === 'button');
      if (alreadyOpen) return;
      const bodyLine = lines.find((l) => l.getAttribute('data-tag') === 'body');
      const toggle = bodyLine && bodyLine.querySelector('button');
      if (toggle) toggle.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
  const line = JSON.parse(
    await page.evalJs(`
      (() => {
        const l = [...document.querySelectorAll('[data-role="inspector-tree-line"]')].find((el) => el.textContent.includes(${JSON.stringify(needle)}));
        if (!l) return JSON.stringify(null);
        const r = l.getBoundingClientRect();
        return JSON.stringify({ x: r.x + 10, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!line) throw new Error(`tree line not found for text: ${needle}`);
  await page.click(line.x, line.y);
  await new Promise((r) => setTimeout(r, 300));
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Listeners Teste", { spawnTerminal: false });
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

  await selectTreeNodeByText(page, "via atributo");

  const subtab = await centerOf(page, '[data-role="inspector-subtab"][data-sub="listeners"]');
  await page.click(subtab.x, subtab.y);
  await new Promise((r) => setTimeout(r, 300));

  check("a nota de escopo (sem CDP/addEventListener) aparece na aba Event Listeners", await page.evalJs(`!!document.querySelector('[data-role="inspector-listeners-notice"]')`), true);

  const withAttrEvents = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-listeners-list"] span')].map((s) => s.textContent))`),
  );
  check("handler via atributo HTML (onclick=\"...\") é detectado de verdade", withAttrEvents.includes("click"), true);

  await selectTreeNodeByText(page, "via propriedade");
  await new Promise((r) => setTimeout(r, 300));
  const withPropEvents = JSON.parse(await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-role="inspector-listeners-list"] span')].map((s) => s.textContent))`));
  check("handler via atribuição direta (el.onmouseenter = fn) também é detectado", withPropEvents.includes("mouseenter"), true);

  await selectTreeNodeByText(page, "sem handler");
  await new Promise((r) => setTimeout(r, 300));
  check(
    "elemento genuinamente sem handler mostra a lista vazia (não inventa nada)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-subpanel"]')?.textContent.includes('Nenhum handler')`),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
