// DESIGN-BACKLOG.md item 19, 2nd revisit — real OS fullscreen (F11,
// win:toggle-fullscreen) already worked but had no visible trigger at
// all, so the user kept clicking the zoom-pill's "ajustar à tela" (zoom-
// to-fit) expecting fullscreen from it ("ele apenas faz zoom"). Covers
// the restored button itself, clicked for real via CDP (not just calling
// the IPC directly) — proves the click actually reaches
// window.winControls.toggleFullscreen(), and that the titlebar genuinely
// unmounts/remounts around it (Titlebar.tsx's existing behavior).
import { startApp, stopApp, connectPage, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = 9416;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-fullscreen", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await bootIntoFreshSession(page);
  await new Promise((r) => setTimeout(r, 300));

  async function clickByTitlePrefix(prefix) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = [...document.querySelectorAll('.zoom-pill button')].find((e) => (e.title || '').startsWith(${JSON.stringify(prefix)}));
          if (!el) return JSON.stringify(null);
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!coords) throw new Error(`no zoom-pill button titled "${prefix}..."`);
    await page.click(coords.x, coords.y);
  }

  check("titlebar visible before fullscreen", await page.evalJs(`!!document.querySelector('.titlebar')`), true);
  check(
    "a distinct fullscreen button sits in the zoom-pill (not just 'ajustar à tela')",
    await page.evalJs(`[...document.querySelectorAll('.zoom-pill button')].some((e) => (e.title || '').includes('Tela cheia'))`),
    true,
  );

  await clickByTitlePrefix("Tela cheia");
  await new Promise((r) => setTimeout(r, 600));
  check("clicking it actually enters real OS fullscreen", await page.evalJs(`window.winControls.isFullscreen()`), true);
  check("titlebar unmounts once fullscreen (header 'sumiu')", await page.evalJs(`!document.querySelector('.titlebar')`), true);
  check(
    "the same zoom-pill button is still reachable to exit (titlebar hiding didn't take it with it)",
    await page.evalJs(`[...document.querySelectorAll('.zoom-pill button')].some((e) => (e.title || '').includes('Sair da tela cheia'))`),
    true,
  );

  await clickByTitlePrefix("Sair da tela cheia");
  await new Promise((r) => setTimeout(r, 600));
  check("clicking it again exits fullscreen", await page.evalJs(`window.winControls.isFullscreen()`), false);
  check("titlebar remounts after exiting", await page.evalJs(`!!document.querySelector('.titlebar')`), true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
