// Settings modal — variant A. Scope is the navigation (Application × This
// board), not a per-row badge. `?` opens the same modal already on Shortcuts
// (the page IS ShortcutsOverlay, not a copy). No `.thin-scroll` class.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-settings-modal-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await bootIntoFreshSession(page, "Settings Modal");
  await delay(600);

  const settingsBtn = await centerOf(page, '.rail-btn[title="Configurações"]');
  await page.click(settingsBtn.x, settingsBtn.y);
  check("rail abre o settings modal", await waitFor(page, `document.querySelector('[data-settings-modal]')`), true);

  const chrome = JSON.parse(
    await page.evalJs(`
      (() => {
        const modal = document.querySelector('[data-settings-modal]');
        const nav = [...document.querySelectorAll('[data-settings-page]')].map((b) => b.getAttribute('data-settings-page'));
        const secs = [...document.querySelectorAll('.settings-nav-sec')].map((s) => s.textContent.trim());
        return JSON.stringify({
          role: modal?.getAttribute('role'),
          boardName: document.querySelector('[data-settings-board-name]')?.textContent?.trim(),
          nav,
          secs,
          providersCurrent: document.querySelector('[data-settings-page="providers"]')?.getAttribute('aria-current') === 'page',
          providersPage: !!document.querySelector('.providers-settings-page'),
          thinScroll: document.querySelectorAll('.thin-scroll').length,
          extraModalRoots: document.querySelectorAll('.modal-root').length,
        });
      })()
    `),
  );
  check("dialog semantics", chrome.role, "dialog");
  check("nome do board no cabeçalho", chrome.boardName, "Settings Modal");
  check("seção Aplicativo na nav", chrome.secs.includes("Aplicativo"), true);
  check("seção Este board na nav", chrome.secs.includes("Este board"), true);
  // task b2a0a4f8 — ordem nova por DECISÃO: Providers primeiro (default da
  // engrenagem), Sobre (id `general`) no fim da seção Aplicativo.
  check("nav app: providers/shortcuts/keys/devices/general", chrome.nav.slice(0, 5).join(","), "providers,shortcuts,keys,devices,general");
  check("nav board: maestro/agents", chrome.nav.slice(5).join(","), "maestro,agents");
  check("rail abre em Providers (default)", chrome.providersCurrent, true);
  check("Providers renderizou a página", chrome.providersPage, true);
  check("zero .thin-scroll", chrome.thinScroll, 0);
  check("um único modal-root (páginas reaproveitadas, sem chrome próprio)", chrome.extraModalRoots, 1);

  // Sobre é a página de idioma/build/escopo agora (o rótulo mudou de
  // "Geral" para "Sobre" por decisão, task b2a0a4f8; o id segue `general`).
  await page.evalJs(`document.querySelector('[data-settings-page="general"]')?.click()`);
  check("Sobre tem o seletor de idioma", await waitFor(page, `document.querySelector('#settings-locale')`), true);

  await page.evalJs(`document.querySelector('[data-settings-page="shortcuts"]')?.click()`);
  check("página Atalhos é o ShortcutsOverlay", await waitFor(page, `document.querySelector('.shortcuts-grid')`), true);

  await page.evalJs(`document.querySelector('[data-settings-page="keys"]')?.click()`);
  check("página Chaves é o SecretsSettingsModal", await waitFor(page, `document.querySelectorAll('.secrets-provider-row').length === 4`), true);

  await page.evalJs(`document.querySelector('[data-settings-page="devices"]')?.click()`);
  check("página Dispositivos é o RemotePairingModal", await waitFor(page, `document.querySelector('.remote-pairing-page')`), true);

  await page.evalJs(`document.querySelector('[data-settings-page="maestro"]')?.click()`);
  check("Maestro tem o toggle autônomo", await waitFor(page, `document.querySelector('.autonomous-toggle-label input')`), true);

  await page.evalJs(`document.querySelector('.autonomous-toggle-label input')?.click()`);
  await delay(250);
  const autonomousOn = await page.evalJs(`document.querySelector('.autonomous-toggle-label input')?.checked`);
  check("toggle autônomo dispara na hora (não espera Fechar)", autonomousOn, true);

  await page.evalJs(`document.querySelector('[data-settings-page="agents"]')?.click()`);
  check("Agentes tem o teto de concorrência", await waitFor(page, `document.querySelector('#settings-concurrency')`), true);

  await page.evalJs(`
    (() => {
      const el = document.querySelector('#settings-concurrency');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '4');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await delay(200);
  const capValue = await page.evalJs(`document.querySelector('#settings-concurrency')?.value`);
  check("teto de concorrência aceita valor", capValue, "4");

  const closeBtn = await centerOf(page, "[data-settings-close]");
  await page.click(closeBtn.x, closeBtn.y);
  await delay(300);
  check("Fechar fecha o modal", await page.evalJs(`!document.querySelector('[data-settings-modal]')`), true);

  // `?` is canvas-scoped and the keyboard guard ignores it while a real
  // control (the rail gear we just clicked, restored by useModal) holds
  // focus — same rule as v/p/c/s. Blur back to the board first.
  await page.evalJs(`document.activeElement?.blur()`);
  await delay(50);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "?", text: "?" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "?", text: "?" });
  check("? reabre o modal", await waitFor(page, `document.querySelector('[data-settings-modal]')`), true);
  const fromShortcut = JSON.parse(
    await page.evalJs(`
      JSON.stringify({
        shortcuts: document.querySelector('[data-settings-page="shortcuts"]')?.getAttribute('aria-current') === 'page',
        grid: !!document.querySelector('.shortcuts-grid'),
      })
    `),
  );
  check("? abre já na página Atalhos", fromShortcut.shortcuts && fromShortcut.grid, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
