// Account/profile switcher prototype (ContaPerfil.dc.html): renders each
// anchored state in an isolated Electron page, checks what the one control and
// the sidebar show, and writes prints under /tmp/conta-perfil/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAppDocument, connectPageRaw, makeChecker, pickFreePort, startApp, stopApp } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTO = join(PROJECT_ROOT, "docs/design/app-v3/prototipo/ContaPerfil.dc.html");
const OUT_DIR = "/tmp/conta-perfil";
mkdirSync(OUT_DIR, { recursive: true });
const { check, finish } = makeChecker();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// anchor -> what must be on screen
const STATES = {
  local: { nav: "sessions,stats", name: "Pessoal", menu: false, pill: false, list: true },
  "conta-pro": { nav: "sessions,inbox,workhome,stats", name: "Pro", menu: false, pill: true, empty: true },
  "conta-time": { nav: "sessions,inbox,workhome,team,stats", name: "Time Exemplo", menu: false, pill: true, list: true, members: true },
  "conta-time-membro": { nav: "sessions,inbox,workhome,team,stats", name: "Time Exemplo", menu: false, pill: true, list: true, members: false },
  trocar: { nav: "sessions,inbox,workhome,stats", name: "Pro", menu: true, rows: ["local-personal", "local-company", "account-pro", "account-team", "sign-out"] },
  "sem-sessao": { nav: "sessions,stats", name: "Pessoal", menu: true, rows: ["local-personal", "sign-in"], noRows: ["account-pro", "sign-out"] },
  offline: { nav: "sessions,inbox,workhome,stats", name: "Pro", menu: true, rows: ["local-personal"], offline: true },
  logado: { nav: "sessions,inbox,workhome,stats", name: "Pro", menu: false, pill: true, empty: true, toast: true },
};
// The sign-in steps replace the shell with the login screen.
const LOGIN = {
  "login-escolha": { step: "choose", error: false },
  "login-aguardando": { step: "email", error: false, text: /Abra o link do e-mail/ },
  "login-aguardando-github": { step: "github", error: false, text: /Abrindo o navegador/ },
  "login-erro": { step: "choose", error: true },
};

const userData = mkdtempSync(join(tmpdir(), "stellar-account-proto-"));
const cdpPort = await pickFreePort();
const app = await startApp({ cdpPort, userDataDir: userData });
try {
  const page = await connectPageRaw(cdpPort);
  await assertAppDocument(page.evalJs);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const [anchor, want] of Object.entries(STATES)) {
    await page.send("Page.navigate", { url: `file://${PROTO}?cena=${anchor}#${anchor}` });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await page.evalJs(`document.documentElement.getAttribute('data-dc-ready') === '1'`).catch(() => false);
      if (!ready) await delay(150);
    }
    check(`#${anchor}: runtime ready`, ready, true);
    if (!ready) console.log("  dc error:", await page.evalJs(`document.documentElement.getAttribute('data-dc-error')`));
    await delay(300);
    const st = await page.evalJs(`(() => ({
      state: document.querySelector('[data-part="app"]')?.getAttribute('data-state'),
      nav: [...document.querySelectorAll('[data-nav]')].map((e) => e.getAttribute('data-nav')).join(','),
      name: document.querySelector('[data-part="switcher-name"]')?.textContent ?? null,
      menu: !!document.querySelector('[data-part="switcher-menu"]'),
      rows: [...document.querySelectorAll('[data-row]')].map((e) => e.getAttribute('data-row')),
      pill: !!document.querySelector('[data-part="context-pill"]'),
      offlineBox: !!document.querySelector('[data-part="menu-offline"]'),
      accountCards: document.querySelectorAll('aside [data-role="account"], aside [data-part="account-card"], aside [data-part="sign-in-card"]').length,
      settings: !!document.querySelector('[data-part="settings"]'),
      unfilled: /\\{\\{|\\}\\}/.test(document.body.innerText),
      overflow: document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight,
    }))()`);
    check(`#${anchor}: state`, st.state, anchor);
    check(`#${anchor}: sidebar sections`, st.nav, want.nav);
    check(`#${anchor}: the control names the profile in view`, st.name, want.name);
    check(`#${anchor}: menu ${want.menu ? "open" : "closed"}`, st.menu, want.menu);
    for (const row of want.rows ?? []) check(`#${anchor}: menu has ${row}`, st.rows.includes(row), true);
    for (const row of want.noRows ?? []) check(`#${anchor}: menu has no ${row}`, st.rows.includes(row), false);
    if (want.pill !== undefined) check(`#${anchor}: context pill ${want.pill ? "shown" : "hidden"}`, st.pill, want.pill);
    if (want.empty !== undefined || want.list) {
      const body = await page.evalJs(`({ empty: !!document.querySelector('[data-part="account-empty"]'), imp: !!document.querySelector('[data-part="import-local"]'), list: document.querySelectorAll('[data-part="session-card"]').length, members: [...document.querySelectorAll('.sub2')].some((e) => /Membros/.test(e.textContent)), toast: !!document.querySelector('[data-part="toast"]') })`);
      check(`#${anchor}: account sessions ${want.empty ? "start empty with an import action" : "listed"}`, want.empty ? body.empty && body.imp && body.list === 0 : body.list > 0 && !body.empty, true);
      if (want.members !== undefined) check(`#${anchor}: Membros ${want.members ? "visible" : "hidden"} (what the backend sends)`, body.members, want.members);
      if (want.toast) check(`#${anchor}: connected toast`, body.toast, true);
    }
    if (want.offline) check(`#${anchor}: offline message with retry in the control`, st.offlineBox, true);
    check(`#${anchor}: no account/sign-in card at the bottom of the sidebar`, st.accountCards, 0);
    check(`#${anchor}: settings stays at the bottom`, st.settings, true);
    check(`#${anchor}: no unfilled placeholders`, st.unfilled, false);
    check(`#${anchor}: fits the window`, st.overflow, false);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `proto-${anchor}.png`), Buffer.from(shot.data, "base64"));
  }
  for (const [anchor, want] of Object.entries(LOGIN)) {
    await page.send("Page.navigate", { url: `file://${PROTO}?cena=${anchor}#${anchor}` });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = await page.evalJs(`document.documentElement.getAttribute('data-dc-ready') === '1'`).catch(() => false);
      if (!ready) await delay(150);
    }
    check(`#${anchor}: runtime ready`, ready, true);
    await delay(300);
    const st = await page.evalJs(`(() => ({
      step: document.querySelector('[data-part="login"]')?.getAttribute('data-step') ?? null,
      shell: !!document.querySelector('[data-part="app"]'),
      error: !!document.querySelector('[data-part="login-error"]'),
      text: document.querySelector('[data-part="login"]')?.innerText ?? '',
      send: document.querySelector('[data-part="login-send"]')?.textContent ?? null,
      github: !!document.querySelector('[data-part="login-github"]'),
      unfilled: /\\{\\{|\\}\\}/.test(document.body.innerText),
      overflow: document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight,
    }))()`);
    check(`#${anchor}: login step`, st.step, want.step);
    check(`#${anchor}: replaces the shell`, st.shell, false);
    check(`#${anchor}: error ${want.error ? "shown with retry" : "hidden"}`, st.error && /Tentar de novo/.test(st.send ?? ""), want.error);
    if (want.text) check(`#${anchor}: text`, want.text.test(st.text), true);
    if (want.step === "choose") check(`#${anchor}: GitHub and e-mail on the choose step`, st.github && /Enviar link|Tentar de novo/.test(st.send ?? ""), true);
    check(`#${anchor}: no unfilled placeholders`, st.unfilled, false);
    check(`#${anchor}: fits the window`, st.overflow, false);
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, `proto-${anchor}.png`), Buffer.from(shot.data, "base64"));
  }
  page.close();
} finally {
  await stopApp(app);
  rmSync(userData, { recursive: true, force: true });
}
finish();
