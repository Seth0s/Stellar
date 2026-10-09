// Settings modal V7 — prototype Configuracoes.dc.html / SPEC-Configuracoes-V7.md
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-settings-modal-${CDP_PORT}`, import.meta.url).pathname;
const SHOT_DIR = new URL("../../.verify-tmp/settings-v7-shots/", import.meta.url).pathname;
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

async function shot(page, name) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const { data } = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const path = join(SHOT_DIR, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

const PAGES = [
  "account",
  "providers",
  "shortcuts",
  "keys",
  "devices",
  "appearance",
  "performance",
  "general",
  "mode",
  "rules",
  "team",
];

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const shotPaths = [];
try {
  const page = await connectPage(CDP_PORT);
  // Prototype canvas is 1440×900; shell is 1280×820 — a smaller window crushed
  // the dialog under global `.modal{max-width:480px}` leftovers and broke shots.
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
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
        const secs = [...document.querySelectorAll('nav [class*=\"secLabel\"]')].map((s) => s.textContent.trim());
        return JSON.stringify({
          role: modal?.getAttribute('role'),
          nav,
          secs,
          search: !!document.querySelector('[data-settings-search]'),
          thinScroll: document.querySelectorAll('.thin-scroll').length,
          extraModalRoots: document.querySelectorAll('.modal-root').length,
        });
      })()
    `),
  );
  check("dialog semantics", chrome.role, "dialog");
  check("busca presente", chrome.search, true);
  check("seção Aplicativo", chrome.secs.some((s) => s.includes("Aplicativo")), true);
  check("seção Este board", chrome.secs.some((s) => s.includes("Este board")), true);
  check("nav V7 completa", chrome.nav.join(","), PAGES.join(","));
  check("zero .thin-scroll", chrome.thinScroll, 0);
  check("um único modal-root", chrome.extraModalRoots, 1);

  const shellSize = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-settings-modal]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
      })()
    `),
  );
  check("shell width ≥ 940", shellSize && shellSize.w >= 940, true);
  check("shell height ≥ 700", shellSize && shellSize.h >= 700, true);

  for (const id of PAGES) {
    await page.evalJs(`document.querySelector('[data-settings-page="${id}"]')?.click()`);
    check(
      `página ${id} ativa`,
      await waitFor(page, `document.querySelector('[data-settings-page="${id}"]')?.getAttribute('aria-current') === 'page'`),
      true,
    );
    // Fresh boards match no preset — apply Orquestrado (produtivo) so the
    // "atual" chrome is visible in the mode screenshot (prototype contract).
    if (id === "mode") {
      await waitFor(page, `!!document.querySelector('[data-preset-id="produtivo"]')`);
      const alreadyCurrent = await page.evalJs(
        `!!document.querySelector('[data-preset-id="produtivo"]')?.innerText?.match(/atual/i)`,
      );
      if (!alreadyCurrent) {
        await page.evalJs(`document.querySelector('[data-preset-id="produtivo"]')?.click()`);
        await waitFor(page, `!!document.querySelector('[data-preset-diff="produtivo"]')`);
        await page.evalJs(`
          (() => {
            const root = document.querySelector('[data-preset-diff="produtivo"]');
            const btn = [...(root?.querySelectorAll('button') ?? [])].find((b) => /Aplicar|Apply/i.test(b.textContent || ""));
            btn?.click();
          })()
        `);
        await waitFor(
          page,
          `!!document.querySelector('[data-preset-id="produtivo"]')?.innerText?.match(/atual/i)`,
          4000,
        );
      }
      await delay(200);
    }
    shotPaths.push(await shot(page, `impl-${id}`));
  }

  // Search active
  await page.evalJs(`
    (() => {
      const el = document.querySelector('[data-settings-search]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'cota');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await delay(150);
  const filtered = JSON.parse(
    await page.evalJs(`JSON.stringify([...document.querySelectorAll('[data-settings-page]')].map((b) => b.getAttribute('data-settings-page')))`),
  );
  check("busca 'cota' → só providers", filtered.join(","), "providers");
  shotPaths.push(await shot(page, "impl-search-cota"));

  // Clear search, open shortcuts for conflict path (UI warning always present)
  await page.evalJs(`
    (() => {
      const el = document.querySelector('[data-settings-search]');
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await delay(100);
  await page.evalJs(`document.querySelector('[data-settings-page="shortcuts"]')?.click()`);
  check("atalhos tem aviso de conflito", await waitFor(page, `!!document.body.innerText.match(/conflito|recusada/i)`), true);
  shotPaths.push(await shot(page, "impl-shortcuts-conflict-hint"));

  await page.evalJs(`document.querySelector('[data-settings-page="providers"]')?.click()`);
  await delay(200);
  const providersUi = JSON.parse(
    await page.evalJs(`
      (() => {
        const add = document.querySelector('[data-role="providers-add"]');
        const cs = add ? getComputedStyle(add) : null;
        const footer = document.querySelector('[data-role="providers-path-footer"]')?.innerText ?? "";
        const link = document.querySelector('[data-role="providers-open-raw"]')?.textContent?.trim() ?? "";
        return JSON.stringify({
          natives: !!document.querySelector('[data-role="providers-natives"]'),
          generics: !!document.querySelector('[data-role="providers-generics"]'),
          add: !!add,
          addBg: cs?.backgroundColor ?? "",
          footer,
          link,
          body: document.querySelector('[data-settings-pane="providers"]')?.innerText ?? "",
        });
      })()
    `),
  );
  check("Providers tem Nativos", providersUi.natives && /Nativos/i.test(providersUi.body), true);
  check("Providers tem Genéricos + Adicionar", providersUi.generics && providersUi.add, true);
  check("Providers path curto com ~", providersUi.link, "~/.config/stellar/providers.json");
  check("Providers path sem pílula no rodapé", !/verify-tmp|\/tmp\//.test(providersUi.link), true);
  // Primary blue #4a5fe0 → rgb(74, 95, 224)
  check(
    "Adicionar é primário azul",
    /rgb\(\s*74\s*,\s*95\s*,\s*224\s*\)/.test(providersUi.addBg),
    true,
  );

  await page.evalJs(`document.querySelector('[data-settings-page="mode"]')?.click()`);
  check("Modo tem toggle autônomo", await waitFor(page, `document.querySelector('[aria-label*=\"autônomo\" i], [aria-label*=\"Autonomous\" i], #settings-concurrency')`), true);
  const modeUi = JSON.parse(
    await page.evalJs(`
      (() => {
        const presets = [...document.querySelectorAll('[data-preset-id]')].map((b) => ({
          id: b.getAttribute('data-preset-id'),
          text: b.innerText,
          current: /atual/i.test(b.innerText),
        }));
        const cap = document.querySelector('#settings-concurrency');
        const report = document.querySelector('[data-role="settings-report-fields"]');
        const reportRow = report?.closest('[class]')?.parentElement;
        return JSON.stringify({
          presets,
          capValue: cap ? String(cap.value) : "",
          reportText: report?.textContent?.trim() ?? "",
          reportTag: report?.tagName ?? "",
          reportParentHasLbl: !!report?.previousElementSibling,
        });
      })()
    `),
  );
  const modeJoined = modeUi.presets.map((p) => p.text).join(" | ");
  check("Modo mostra Junto", /Junto/i.test(modeJoined), true);
  check("Modo mostra Orquestrado", /Orquestrado/i.test(modeJoined), true);
  check("Modo mostra Autônomo", /Autônomo/i.test(modeJoined), true);
  check("Modo não mostra Eficiente", !/Eficiente/i.test(modeJoined), true);
  check(
    "Modo tem preset atual marcado",
    modeUi.presets.some((p) => p.current),
    true,
  );
  check("Agentes ao mesmo tempo tem valor", modeUi.capValue !== "" && Number(modeUi.capValue) > 0, true);
  check("Campos do relatório na mesma linha (irmão, não filho do lbl)", modeUi.reportParentHasLbl, true);

  const closeBtn = await centerOf(page, "[data-settings-close]");
  await page.click(closeBtn.x, closeBtn.y);
  await delay(300);
  check("Fechar fecha o modal", await page.evalJs(`!document.querySelector('[data-settings-modal]')`), true);

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

  writeFileSync(join(SHOT_DIR, "paths.json"), JSON.stringify(shotPaths, null, 2));
  page.close();
} finally {
  await stopApp(app);
}
finish();
console.log("screenshots:", SHOT_DIR);
