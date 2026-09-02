// DESIGN-BACKLOG.md item 17 — updater UI (banner, "lembrar depois",
// changelog toggle, titlebar pending-update dot). `update-available` only
// ever fires for real from a packaged build with a working publish feed
// (none exists yet — see docs/packaging.md), so this drives the UI via
// `window.updater.testEmitAvailable` (main/updater.ts's `app.isPackaged`-
// guarded test-only trigger) instead of a real update.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9413;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-updater", import.meta.url).pathname;

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Alpha", { spawnTerminal: false });

  check("no update banner before any update is found", await page.evalJs(`!!document.querySelector('.update-banner')`), false);
  check("no pending-update dot in the titlebar yet", await page.evalJs(`!!document.querySelector('.titlebar-update-dot')`), false);

  // Achado ao vivo (2026-09-02) — não existia jeito nenhum de disparar
  // uma checagem sob demanda, só a automática de boot. Botão manual
  // sempre visível no titlebar (item novo, `useUpdateStatus.ts`'s
  // `checkNow`), independente de já haver update pendente ou não.
  check("manual update-check button exists in the titlebar", await page.evalJs(`!!document.querySelector('.titlebar-update-check')`), true);
  await new Promise((r) => setTimeout(r, 300)); // let the dev-build boot check (no-op, `app.isPackaged` false) settle
  check(
    "manual check button has no error state after the dev boot check",
    await page.evalJs(`document.querySelector('.titlebar-update-check')?.classList.contains('has-error')`),
    false,
  );
  await page.evalJs(`document.querySelector('.titlebar-update-check')?.click()`);
  await new Promise((r) => setTimeout(r, 300));
  check(
    "manual click re-runs the check and settles back out of the 'checking' state",
    await page.evalJs(`document.querySelector('.titlebar-update-check')?.classList.contains('is-checking')`),
    false,
  );

  const NOTES = "- fixed a bug\n- added a feature";
  await page.evalJs(`window.updater.testEmitAvailable("1.2.3", ${JSON.stringify(NOTES)})`);
  await new Promise((r) => setTimeout(r, 300));

  check("banner appears with the version", await page.evalJs(`document.querySelector('.update-banner-row')?.textContent?.includes('1.2.3')`), true);
  check("titlebar pending-update dot appears too", await page.evalJs(`!!document.querySelector('.titlebar-update-dot')`), true);
  check("release notes collapsed by default", await page.evalJs(`!document.querySelector('.update-banner-notes')`), true);

  // Changelog toggle.
  await page.evalJs(`document.querySelector('.update-banner-notes-toggle')?.click()`);
  await new Promise((r) => setTimeout(r, 150));
  check(
    "'ver novidades' reveals the real release notes text",
    await page.evalJs(`document.querySelector('.update-banner-notes')?.textContent`),
    NOTES,
  );

  // "lembrar depois" — banner hides, dot survives.
  await page.evalJs(`document.querySelector('.update-banner-later')?.click()`);
  await new Promise((r) => setTimeout(r, 150));
  check("'lembrar depois' hides the banner", await page.evalJs(`!!document.querySelector('.update-banner')`), false);
  check("titlebar dot stays up after 'lembrar depois'", await page.evalJs(`!!document.querySelector('.titlebar-update-dot')`), true);

  // Clicking the dot brings the banner right back (not waiting the full
  // remind-later window).
  await page.evalJs(`document.querySelector('.titlebar-update-dot')?.click()`);
  await new Promise((r) => setTimeout(r, 150));
  check("clicking the titlebar dot re-shows the banner", await page.evalJs(`!!document.querySelector('.update-banner')`), true);

  // "instalar e reiniciar" — dev build always answers with a soft error
  // (main/updater.ts's own `app.isPackaged` guard on updater:install),
  // never actually attempts an install; confirms the failure surfaces in
  // the UI instead of silently doing nothing.
  await page.evalJs(`[...document.querySelectorAll('.update-banner-row button')].find((b) => b.textContent.includes('instalar'))?.click()`);
  await new Promise((r) => setTimeout(r, 300));
  check(
    "install failure (dev build) surfaces as an error in the banner",
    await page.evalJs(`!!document.querySelector('.update-banner-error')`),
    true,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
