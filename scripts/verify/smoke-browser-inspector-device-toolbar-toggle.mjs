// DESIGN-BACKLOG.md §2.1 item 4 (2026-09-07) — decisão do usuário: a
// barra de dispositivo do inspector (device toolbar) deixa de ser sempre
// visível (era assim desde o commit `aebc955`) e vira um toggle,
// escondida por padrão, igual o protótipo HTML aprovado.
//
// Revisto ao vivo em 2026-09-07: o botão morava no address bar do
// próprio BrowserCard.tsx (existia mesmo com o inspector fechado, pra
// abrir-e-mostrar num clique só). Pedido explícito do usuário: mover a
// ferramenta de device-frame pra DENTRO do inspector, como um ícone na
// barra de abas — agora só existe (e só é clicável) com o inspector já
// aberto; abrir o inspector continua sendo o fluxo normal do kebab
// ("Abrir inspector"). O ESTADO (`deviceToolbarOpen`) continua morando em
// BrowserCard.tsx e sobrevivendo o inspector fechar/reabrir — só o botão
// mudou de lugar.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { createServer } from "node:http";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-browser-inspector-device-toolbar-toggle-${CDP_PORT}`, import.meta.url).pathname;

const FIXTURE_HTML = `<!doctype html><html><body style="margin:0"><h1 id="title">Fixture</h1></body></html>`;
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
  await bootIntoFreshSession(page, "Device Toolbar Toggle Teste", { spawnTerminal: false });
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

  check("sem o inspector aberto, o ícone de device toolbar nem existe (agora vive DENTRO do inspector, não no address bar)", await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar-toggle"]')`), false);

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

  check("com o inspector aberto, o ícone de device toolbar aparece na barra de abas", await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar-toggle"]')`), true);
  check("...e não aparece 'ativo' antes de qualquer clique (barra escondida por padrão)", await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar"]')`), false);
  check("...e o botão em si não mostra data-active antes de clicar", await page.evalJs(`document.querySelector('[data-role="inspector-device-toolbar-toggle"]').getAttribute('data-active')`), null);

  const deviceToggle = await centerOf(page, '[data-role="inspector-device-toolbar-toggle"]');
  await page.click(deviceToggle.x, deviceToggle.y);
  await new Promise((r) => setTimeout(r, 400));

  check("clicar no ícone mostra a barra de dispositivo", await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar"]')`), true);
  check("...e o botão reflete o estado 'ativo'", await page.evalJs(`document.querySelector('[data-role="inspector-device-toolbar-toggle"]').getAttribute('data-active')`), "true");

  // Liga emulação de verdade, depois esconde a barra de novo — o
  // device-frame (a emulação em si) não deve ser afetado por isso, só a
  // VISIBILIDADE dos controles: esconder não é a mesma coisa que "Parar
  // emulação".
  await page.evalJs(`
    (() => {
      const select = document.querySelector('[data-role="inspector-device-select"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'Mobile (390×844)');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  const widthEmulating = JSON.parse(
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.innerWidth").then((r) => JSON.stringify(r))`),
  );
  check("emulação Mobile de verdade ligada antes de esconder a barra", widthEmulating.result, "390");

  const deviceToggle2 = await centerOf(page, '[data-role="inspector-device-toolbar-toggle"]');
  await page.click(deviceToggle2.x, deviceToggle2.y);
  await new Promise((r) => setTimeout(r, 400));

  check("clicar de novo esconde a barra de dispositivo", await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar"]')`), false);
  check("...mas o inspector continua aberto (o toggle não fecha o painel inteiro)", await page.evalJs(`!!document.querySelector('[data-role="browser-inspector"]')`), true);
  check(
    "...e a emulação continua ativa de verdade (esconder controles ≠ 'Parar emulação')",
    await page.evalJs(`document.querySelector('[data-role="browser-body"]').parentElement.getAttribute('data-emulating')`),
    "true",
  );
  const widthAfterHide = JSON.parse(
    await page.evalJs(`window.browser.evalJs(${JSON.stringify(browserId)}, "window.innerWidth").then((r) => JSON.stringify(r))`),
  );
  check("...a página continua em 390 de innerWidth mesmo com a barra escondida", widthAfterHide.result, "390");

  // Fecha e reabre o inspector — o estado (deviceToolbarOpen mora em
  // BrowserCard.tsx) deve sobreviver, mesmo o BOTÃO agora vivendo dentro
  // do inspector que acabou de desmontar.
  // DESIGN-BACKLOG.md item 3 (refactor overlay→reflow, 2026-09-07): o
  // dock agora encolhe de VERDADE sob aperto (ex: emulação de um
  // dispositivo largo deixando pouco espaço) — a própria barra de abas
  // (`.inspectorTabs`, `overflow-x:auto`) pode rolar o botão de fechar
  // pra fora da área visível, exatamente como um usuário real precisaria
  // rolar pra alcançá-lo. `scrollIntoView` simula esse gesto antes de
  // medir/clicar.
  const closeBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-inspector"] button')].find((x) => x.title === 'Fechar inspector');
        if (!b) return JSON.stringify(null);
        b.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(closeBtn.x, closeBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  check("fechar o inspector some com o painel", await page.evalJs(`!!document.querySelector('[data-role="browser-inspector"]')`), false);

  const kebab2 = await centerOf(page, '[data-role="browser-address"] button[title="Mais opções"]');
  await page.click(kebab2.x, kebab2.y);
  await new Promise((r) => setTimeout(r, 300));
  const inspectorBtn2 = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('[data-role="browser-menu"] button')].find((x) => x.textContent.includes('Abrir inspector'));
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  await page.click(inspectorBtn2.x, inspectorBtn2.y);
  await new Promise((r) => setTimeout(r, 500));
  check("...reabrir mantém o estado de antes de fechar (barra continua escondida — deviceToolbarOpen persistiu em BrowserCard.tsx mesmo com o botão dentro do inspector tendo desmontado)", await page.evalJs(`!!document.querySelector('[data-role="inspector-device-toolbar"]')`), false);

  page.close();
} finally {
  await stopApp(app);
  server.close();
}
finish();
