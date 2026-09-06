// Pendentes #188 — "Design mode / DevTools embutido" no browser card.
// Achado: já estava implementado ponta a ponta (browser-registry.ts's
// openDevTools, IPC browser:open-devtools, preload, botão "Abrir DevTools"
// no menu kebab de BrowserCard.tsx) — só faltava confirmar que ainda
// funciona. `smoke-browser-header-tools.mjs` já cobre isso mas falha antes
// de chegar lá por um motivo não relacionado (o card spawnado via
// spawn_card/MCP nesse teste nasce fora da viewport — mesma família do bug
// de `centeredSlot` corrigido em `aa04576`, só que pelo caminho MCP, que
// deliberadamente não ganha auto-recentralização, ver App.tsx's addCard
// doc comment). Este teste usa o caminho da Rail (já corrigido) pra isolar
// só a confirmação de DevTools em si.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-devtools-confirm-${CDP_PORT}`, import.meta.url).pathname;

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

const FIXTURE_HTML = `<div id="marker">still alive</div>`;
const httpPort = await pickFreePort();
const server = createServer((req, res) => {
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
  await bootIntoFreshSession(page, "DevTools Confirm Teste");
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

  const devToolsBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-menu"] button')].find((x) => x.textContent.includes('DevTools'));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  check("botão 'Abrir DevTools' existe no menu do browser card", devToolsBtn !== null, true);

  await page.click(devToolsBtn.x, devToolsBtn.y);
  await new Promise((r) => setTimeout(r, 1000));

  // DevTools abre como janela separada (mode: 'detach') — confirma via CDP
  // que um NOVO target de DevTools realmente apareceu.
  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  const devToolsTarget = targets.find((t) => /devtools/i.test(t.url ?? "") || /devtools/i.test(t.title ?? ""));
  check("um target real de DevTools apareceu na lista CDP depois do clique", !!devToolsTarget, true);

  // A página embutida continua respondendo depois de abrir DevTools nela.
  const pageText = JSON.parse(
    await page.evalJs(`window.browser.getPageText(${JSON.stringify(browserId)}).then((r) => JSON.stringify(r))`),
  );
  check("a página embutida continua respondendo depois de abrir DevTools (não travou)", pageText.ok && pageText.text.includes("still alive"), true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
