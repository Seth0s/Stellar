// DESIGN-BACKLOG.md §2.1 (adoção de CDP, Fase 0) — plumbing de
// `webContents.debugger` pro inspector embutido: `browser-cdp.ts`
// (lifecycle attach/detach/send), IPC `browser:cdp-attach`/`cdp-detach`/
// `cdp-send`/`cdp-event`, e o efeito em `BrowserInspector.tsx` que
// anexa no MOUNT e desanexa no UNMOUNT do componente (não na criação/
// destruição do card — a maioria dos browser cards nunca abre o
// inspector, então nunca paga o custo de uma sessão CDP). Nenhuma
// feature visível ainda (Elements/Styles/etc. continuam no `evalJs`
// antigo até as próximas fases) — este teste prova só o PLUMBING:
// attach real funciona, detach real desliga, e o caso de conflito
// documentado (Electron só permite um consumidor do protocolo de
// depuração por webContents — DevTools real vs. sessão do inspector)
// falha limpo com um banner na UI, não trava/crasha.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-cdp-lifecycle-${CDP_PORT}`, import.meta.url).pathname;

const FIXTURE_HTML = `<!doctype html><html><body><h1 id="marker">still alive</h1></body></html>`;
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
  if (!res) throw new Error(`not found: ${selector}`);
  return res;
}

async function openKebab(page) {
  const kebab = await centerOf(page, '[data-role="browser-address"] button[title="Mais opções"]');
  await page.click(kebab.x, kebab.y);
  await new Promise((r) => setTimeout(r, 300));
}

async function clickMenuButton(page, textIncludes) {
  const btn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-menu"] button')].find((x) => x.textContent.includes(${JSON.stringify(textIncludes)}));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!btn) throw new Error(`menu button not found: ${textIncludes}`);
  await page.click(btn.x, btn.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "CDP Lifecycle Teste", { spawnTerminal: false });
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

  // Antes de abrir o inspector: sendCdp deve falhar limpo (sem sessão nenhuma).
  const beforeOpen = JSON.parse(
    await page.evalJs(`window.browser.sendCdp(${JSON.stringify(browserId)}, "DOM.getDocument", {depth:0}).then((r) => JSON.stringify(r))`),
  );
  check("sendCdp falha limpo (não crasha) antes do inspector abrir", beforeOpen.ok, false);

  await openKebab(page);
  await clickMenuButton(page, "Abrir inspector");
  await new Promise((r) => setTimeout(r, 500));

  check(
    "sem conflito de DevTools, o inspector abre sem banner de erro CDP",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-cdp-error"]')`),
    false,
  );

  const afterOpen = JSON.parse(
    await page.evalJs(`window.browser.sendCdp(${JSON.stringify(browserId)}, "DOM.getDocument", {depth:0}).then((r) => JSON.stringify(r))`),
  );
  check("sendCdp funciona de verdade com o inspector aberto (comando CDP real, DOM.getDocument)", afterOpen.ok, true);
  check(
    "...e o resultado é uma árvore real (raiz #document)",
    afterOpen.result?.root?.nodeName,
    "#document",
  );

  // Fecha o inspector — unmount de BrowserInspector.tsx deve desanexar
  // a sessão CDP de verdade (não só escondê-la).
  const closeBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-inspector"] button')].find((x) => x.title === 'Fechar inspector');
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  const afterClose = JSON.parse(
    await page.evalJs(`window.browser.sendCdp(${JSON.stringify(browserId)}, "DOM.getDocument", {depth:0}).then((r) => JSON.stringify(r))`),
  );
  check("fechar o inspector desanexa a sessão CDP de verdade (sendCdp volta a falhar limpo)", afterClose.ok, false);

  // Reabrir funciona de novo (attach não é um recurso de uso único).
  await openKebab(page);
  await clickMenuButton(page, "Abrir inspector");
  await new Promise((r) => setTimeout(r, 500));
  const afterReopen = JSON.parse(
    await page.evalJs(`window.browser.sendCdp(${JSON.stringify(browserId)}, "DOM.getDocument", {depth:0}).then((r) => JSON.stringify(r))`),
  );
  check("reabrir o inspector reanexa a sessão CDP de verdade", afterReopen.ok, true);

  // Fecha de novo antes do cenário de conflito.
  const closeBtn2 = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-inspector"] button')].find((x) => x.title === 'Fechar inspector');
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(closeBtn2.x, closeBtn2.y);
  await new Promise((r) => setTimeout(r, 300));

  // Cenário de conflito real: abre o DevTools de verdade primeiro (mesmo
  // protocolo, um consumidor só por webContents), depois tenta abrir o
  // inspector embutido — deve falhar com o banner, não travar/crashar.
  await openKebab(page);
  await clickMenuButton(page, "DevTools");
  await new Promise((r) => setTimeout(r, 1000));

  const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json());
  const devToolsTarget = targets.find((t) => /devtools/i.test(t.url ?? "") || /devtools/i.test(t.title ?? ""));
  check("DevTools real de fato abriu (target CDP novo apareceu)", !!devToolsTarget, true);

  await openKebab(page);
  await clickMenuButton(page, "Abrir inspector");
  await new Promise((r) => setTimeout(r, 500));

  check(
    "abrir o inspector com DevTools real já aberto mostra o banner de erro (não crasha)",
    await page.evalJs(`!!document.querySelector('[data-role="inspector-cdp-error"]')`),
    true,
  );
  const bannerText = await page.evalJs(`document.querySelector('[data-role="inspector-cdp-error"]')?.textContent ?? ""`);
  check(`...e o texto do banner menciona o conflito (real: "${bannerText}")`, bannerText.toLowerCase().includes("devtools"), true);

  const conflictSend = JSON.parse(
    await page.evalJs(`window.browser.sendCdp(${JSON.stringify(browserId)}, "DOM.getDocument", {depth:0}).then((r) => JSON.stringify(r))`),
  );
  check("...e sendCdp continua falhando limpo nesse estado (sem sessão de verdade)", conflictSend.ok, false);

  // A página embutida continua respondendo — o conflito de protocolo não
  // travou o webContents em si, só a sessão do inspector.
  const pageText = JSON.parse(
    await page.evalJs(`window.browser.getPageText(${JSON.stringify(browserId)}).then((r) => JSON.stringify(r))`),
  );
  check("a página embutida continua respondendo depois do conflito (não travou)", pageText.ok && pageText.text.includes("still alive"), true);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
