// BOARD PRESETS, FASE 2 (task 83f4cfa3) — o fluxo da UI no app REAL.
//
// O que este smoke mede, e por que ele precisa de uma instância ISOLADA
// (userDataDir próprio + porta CDP própria, como `smoke-settings-modal.mjs`):
// aplicar um preset ESCREVE no board aberto (autônomo, teto, defaults de
// contrato). Rodar isto contra o board do dono mexeria no estado real dele.
//
// A ordem das asserções segue a promessa da feature, não o layout:
//   1. o board recém-criado NÃO casa preset nenhum — é `custom`, e a UI diz
//      isso em vez de escolher um nome por conta própria;
//   2. clicar num preset mostra o DIFF ANTES de aplicar — "isto vai mudar" com
//      antes → depois por ajuste — e nada foi escrito ainda (o checkbox de
//      autônomo continua desmarcado enquanto o painel está aberto);
//   3. o "Máximo" diz seu custo com LINK da doc e sem número de token;
//   4. só o clique em Aplicar escreve: autônomo liga, o teto vira 8, e o badge
//      passa a dizer "Máximo";
//   5. mexer um ajuste à mão depois derruba o badge para `custom` — a UI nunca
//      reivindica um preset que os ajustes já não satisfazem.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-board-presets-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, expr, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evalJs(`!!(${expr})`)) return true;
    await delay(80);
  }
  return false;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Presets Smoke");
  await delay(600);

  // Abre as configurações pela engrenagem da rail (mesma porta do smoke do
  // modal) e vai para a aba do board, onde os presets moram.
  const gear = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.rail-btn[title="Configurações"]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (gear) await page.click(gear.x, gear.y);
  check("settings modal abriu", await waitFor(page, `document.querySelector('[data-settings-modal]')`), true);

  await page.evalJs(`document.querySelector('[data-settings-page="maestro"]')?.click()`);
  check("o seletor de presets renderizou", await waitFor(page, `document.querySelector('[data-preset-block]')`), true);
  // A lista vem do MAIN por IPC (assíncrona): esperar por ela, não pelo bloco.
  check("a lista chegou do main (3 presets)", await waitFor(page, `document.querySelectorAll('[data-preset-id]').length === 3`), true);
  check(
    "os ids são eficiente/produtivo/maximo",
    await page.evalJs(
      `[...document.querySelectorAll('[data-preset-id]')].map((b) => b.getAttribute('data-preset-id')).join(',')`,
    ),
    "eficiente,produtivo,maximo",
  );

  check(
    "board recém-criado lê como custom (nunca um preset que não bate)",
    await waitFor(page, `document.querySelector('[data-preset-current]')?.getAttribute('data-preset-current') === 'custom'`),
    true,
  );

  // O custo do "Máximo": link da doc, e NENHUM número de token inventado.
  const maximo = JSON.parse(
    await page.evalJs(`
      (() => {
        const docs = document.querySelector("[data-preset-docs='maximo']");
        const cost = document.querySelector("[data-preset-cost='maximo']")?.textContent ?? '';
        return JSON.stringify({ href: docs?.getAttribute('href') ?? null, hasDigit: /[0-9]/.test(cost), cost });
      })()
    `),
  );
  check("Máximo linka a página dos três jeitos", maximo.href, "https://stellar.idyplatform.com/docs/tres-jeitos-de-trabalhar/");
  check("o custo do Máximo não inventa número", maximo.hasDigit, false);

  // ============ O DIFF, ANTES DE APLICAR ============
  await page.evalJs(`document.querySelector("[data-preset-id='maximo']")?.click()`);
  check("clicar no preset abre o painel do diff", await waitFor(page, `document.querySelector("[data-preset-diff='maximo']")`), true);

  const before = JSON.parse(
    await page.evalJs(`
      (() => {
        const items = [...document.querySelectorAll('[data-preset-change]')].map((li) => ({
          setting: li.getAttribute('data-preset-change'),
          text: li.textContent,
        }));
        return JSON.stringify({
          settings: items.map((i) => i.setting).sort(),
          cap: items.find((i) => i.setting === 'concurrencyCap')?.text ?? '',
          autonomousRow: items.find((i) => i.setting === 'autonomous')?.text ?? '',
          scope: document.querySelector("[data-preset-diff='maximo']")?.textContent ?? '',
          toggleChecked: document.querySelector('.autonomous-toggle-label input')?.checked === true,
        });
      })()
    `),
  );
  check("o diff nomeia os quatro ajustes", before.settings.join(","), "autonomous,concurrencyCap,defaultAllowCommit,defaultReview");
  check("o teto aparece com o valor novo (8)", /8/.test(before.cap), true);
  check("o diff diz antes → depois no modo autônomo", /desligado → ligado/.test(before.autonomousRow), true);
  check("o painel promete escopo: só o que vem a seguir", /só para o que vem a seguir/.test(before.scope), true);
  check("NADA foi escrito antes de aplicar (autônomo segue desmarcado)", before.toggleChecked, false);

  // ============ APLICAR ============
  await page.evalJs(`document.querySelector("[data-preset-apply='maximo']")?.click()`);
  await delay(400);
  const after = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const b = boards[0] ?? {};
        return JSON.stringify({
          badge: document.querySelector('[data-preset-current]')?.getAttribute('data-preset-current'),
          badgeText: document.querySelector('[data-preset-current]')?.textContent ?? '',
          toggleChecked: document.querySelector('.autonomous-toggle-label input')?.checked === true,
          panelClosed: !document.querySelector("[data-preset-diff='maximo']"),
          db: {
            autonomous: b.autonomous,
            concurrency_cap: b.concurrency_cap,
            default_review: b.default_review ?? null,
            default_allow_commit: b.default_allow_commit ?? null,
          },
        });
      })()
    `),
  );
  check("o painel fecha depois de aplicar", after.panelClosed, true);
  check("o badge passa a dizer Máximo", after.badge, "maximo");
  check("o modo autônomo ligou no board", after.toggleChecked, true);
  // A ESCRITA CHEGOU AO BANCO: `boards.list()` é uma releitura por IPC do
  // SQLite, não o otimismo do renderer.
  check("autônomo persistido no banco", after.db.autonomous, true);
  check("teto do Máximo persistido (8)", after.db.concurrency_cap, 8);
  check("default de review persistido (revisor por task)", after.db.default_review, "wanted");
  check("default de commit persistido (não permitido)", after.db.default_allow_commit, 0);

  // ============ MEXER UM AJUSTE DEPOIS => CUSTOM ============
  await page.evalJs(`document.querySelector('[data-settings-page="agents"]')?.click()`);
  check("aba Agentes tem o teto", await waitFor(page, `document.querySelector('#settings-concurrency')`), true);
  await page.evalJs(`
    (() => {
      const el = document.querySelector('#settings-concurrency');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '7');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await delay(250);
  await page.evalJs(`document.querySelector('[data-settings-page="maestro"]')?.click()`);
  check("com o teto mexido à mão, o board lê como custom", await waitFor(page, `document.querySelector('[data-preset-current]')?.getAttribute('data-preset-current') === 'custom'`), true);

  // E o mesmo ajuste à mão continuou sendo um caminho que a UI conhece: o
  // preset que ele ANTES mostrava agora lista essa única mudança.
  await page.evalJs(`document.querySelector("[data-preset-id='maximo']")?.click()`);
  check(
    "voltar ao preset lista SÓ o teto como mudança",
    await waitFor(page, `[...document.querySelectorAll('[data-preset-change]')].map((li) => li.getAttribute('data-preset-change')).join(',') === 'concurrencyCap'`),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
