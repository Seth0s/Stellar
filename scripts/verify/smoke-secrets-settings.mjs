// DESIGN-BACKLOG.md item 29 — UI/UX de API keys. Usuário escolheu as 3
// opções: (1) indicador visual de quais providers já têm key, (2) painel
// central de gerenciamento, (3) polish (mostrar/ocultar, validação
// suave, erros mais claros). Prova real, sem mock: escreve uma key de
// verdade pelo painel central, confirma via `window.secrets.hasKey` que
// persistiu de verdade (não otimista), confirma que o dot no picker do
// ChatCard reflete isso, testa mostrar/ocultar, e o caminho de erro real
// (baseURL vazio pro provider custom já é bloqueado no próprio botão).
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, spawnCard, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-secrets-settings-${CDP_PORT}`, import.meta.url).pathname;

async function centerOf(page, selector) {
  let res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res && selector.includes(".rail-btn[title=")) {
    const titleMatch = selector.match(/title=["']([^"']+)["']/);
    if (titleMatch) {
      const title = titleMatch[1];
      const addBtn = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector('[data-role="rail-add-card"]');
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (addBtn) {
        await page.click(addBtn.x, addBtn.y);
        await new Promise((r) => setTimeout(r, 250));
        res = JSON.parse(
          await page.evalJs(`
            (() => {
              const el = document.querySelector(\`.popover-row[title="${title}"]\`);
              if (!el) return JSON.stringify(null);
              const r = el.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
      }
    }
  }
  return res;
}
async function typeInto(page, selector, value) {
  const coords = await centerOf(page, selector);
  await page.click(coords.x, coords.y);
  await page.evalJs(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Secrets Settings Teste");
  await new Promise((r) => setTimeout(r, 800));

  const settingsBtn = await centerOf(page, '.rail-btn[title="Configurações"]');
  await page.click(settingsBtn.x, settingsBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  await page.evalJs(`document.querySelector('[data-settings-page="keys"]')?.click()`);
  await new Promise((r) => setTimeout(r, 400));

  check("painel central abre com os 4 providers", await page.evalJs(`document.querySelectorAll('.secrets-provider-row').length`), 4);
  const geminiHasKeyBefore = await page.evalJs(`window.secrets.hasKey('gemini')`);
  check("gemini começa sem key", geminiHasKeyBefore, false);

  // Escreve uma key real pro gemini pelo painel central.
  const geminiRow = await page.evalJs(`
    (() => {
      const rows = [...document.querySelectorAll('.secrets-provider-row')];
      const row = rows.find((r) => r.querySelector('.secrets-provider-name')?.textContent === 'gemini');
      return row ? Array.from(document.querySelectorAll('.secrets-provider-row')).indexOf(row) : -1;
    })()
  `);
  const geminiInputSelector = `.secrets-provider-row:nth-child(${geminiRow + 1}) input[type="password"]`;
  await typeInto(page, geminiInputSelector, "AIzaTestKeyFromSmokeTest");
  const geminiSaveBtn = await centerOf(page, `.secrets-provider-row:nth-child(${geminiRow + 1}) button.primary`);
  await page.click(geminiSaveBtn.x, geminiSaveBtn.y);
  await new Promise((r) => setTimeout(r, 400));

  const geminiHasKeyAfter = await page.evalJs(`window.secrets.hasKey('gemini')`);
  check("gemini realmente tem key persistida depois de salvar pelo painel central (não otimista)", geminiHasKeyAfter, true);
  check(
    "a linha do gemini no painel mostra 'configurada' agora",
    await page.evalJs(`document.querySelectorAll('.secrets-provider-row')[${geminiRow}]?.querySelector('.secrets-provider-status')?.textContent`),
    "configurada",
  );

  // Fecha o painel, abre um chatbox — o dot do provider picker deve
  // refletir a key real que acabou de ser salva.
  const closeBtn = await centerOf(page, "[data-settings-close]");
  await page.click(closeBtn.x, closeBtn.y);
  await spawnCard(page, "chat");
  await new Promise((r) => setTimeout(r, 500));

  const geminiDotFilled = await page.evalJs(`
    [...document.querySelectorAll('.chat-provider-picker button')].find((b) => b.textContent.trim().startsWith('gemini'))?.querySelector('.chat-provider-dot')?.classList.contains('has-key')
  `);
  check("o dot do gemini no ChatCard reflete a key salva pelo painel central", geminiDotFilled, true);

  // Mostrar/ocultar no form inline do ChatCard (provider ainda é
  // anthropic, sem key — form já está aberto).
  await typeInto(page, '.chat-key-form input[type="password"]', "sk-ant-test-reveal-check");
  const revealBtn = await centerOf(page, ".chat-key-reveal");
  await page.click(revealBtn.x, revealBtn.y);
  await new Promise((r) => setTimeout(r, 150));
  const revealedType = await page.evalJs(`document.querySelector('.chat-key-form input[type="text"]')?.value`);
  check("botão de mostrar/ocultar revela o valor digitado de verdade", revealedType, "sk-ant-test-reveal-check");

  // Validação suave: uma key anthropic sem o prefixo esperado mostra um
  // aviso, mas NÃO bloqueia o botão salvar.
  await typeInto(page, '.chat-key-form input[type="text"]', "totally-wrong-format");
  await new Promise((r) => setTimeout(r, 150));
  const warningText = await page.evalJs(`document.querySelector('.chat-key-warn:last-of-type')?.textContent`);
  check("aviso de formato aparece pra um valor que não parece uma key anthropic", warningText?.includes("sk-ant-"), true);
  const saveBtnDisabled = await page.evalJs(`document.querySelector('.chat-key-row button.primary')?.disabled`);
  check("...mas o aviso NÃO desabilita o botão salvar (é só um aviso, não bloqueio)", saveBtnDisabled, false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
