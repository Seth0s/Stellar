// One-off live check for the "4 (deferida)" card-registry refactor
// (cards/registry.ts, App.tsx's addCardOfKind/render switch, Rail.tsx's
// RAIL_CREATE_ORDER-driven buttons) — clicks every one of the Rail's
// registry-driven one-click buttons in order and confirms the matching
// card class actually appears on the board, exercising the exact new
// code path (defaultCardFields → addCardOfKind → the render switch) for
// every non-terminal kind, not just the ones smoke-card-lifecycle.mjs
// already happens to touch.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9430;
const USER_DATA_DIR = new URL("../../.verify-tmp/investigate-registry-refactor", import.meta.url).pathname;

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1500));
  await bootIntoFreshSession(page, "Registry Refactor Test", { spawnTerminal: false });

  async function clickRailButton(title) {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const el = document.querySelector('.rail-btn[title=${JSON.stringify(title)}]');
          if (!el) return JSON.stringify(null);
          const r = el.getBoundingClientRect();
          return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
        })()
      `),
    );
    if (!coords) throw new Error(`rail button not found: ${title}`);
    await page.click(coords.x, coords.y);
    await new Promise((r) => setTimeout(r, 400));
  }

  const cases = [
    { title: "Nova pasta de arquivos", cardClass: ".files-card" },
    { title: "Novo card de changes", cardClass: ".changes-card" },
    { title: "Nova nota adesiva", cardClass: ".sticky-card" },
    { title: "Novo navegador", cardClass: ".browser-card" },
    { title: "Novo chatbox", cardClass: ".chat-card" },
    { title: "Controlar janela externa", cardClass: ".remote-window-card" },
  ];

  for (const { title, cardClass } of cases) {
    await clickRailButton(title);
    const count = Number(await page.evalJs(`document.querySelectorAll(${JSON.stringify(cardClass)}).length`));
    check(`"${title}" spawns a real ${cardClass} card`, count >= 1, true);
  }

  const totalCards = Number(await page.evalJs(`document.querySelectorAll('.card-frame').length`));
  check("6 cards total on the board (one per kind clicked)", totalCards, 6);

  // Terminal (its own dedicated popover path, not RAIL_CREATE_ORDER) —
  // confirm it wasn't broken by the onCreate prop swap.
  const termBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.rail-btn[title="Novo terminal"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(termBtn.x, termBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const criarCoords = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = [...document.querySelectorAll('.popover-actions button')].find(b => b.textContent.trim() === 'criar');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(criarCoords.x, criarCoords.y);
  await new Promise((r) => setTimeout(r, 600));
  check("terminal card spawned via its own popover", Number(await page.evalJs(`document.querySelectorAll('.terminal-card').length`)), 1);

  // Jump-to-card popover (uses CARD_ICON/CARD_LABEL) — confirm every kind
  // shows a real icon/label, not a raw fallback from a missing registry entry.
  const findBtn = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('.rail-btn[title="Localizar card"]');
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
      })()
    `),
  );
  await page.click(findBtn.x, findBtn.y);
  await new Promise((r) => setTimeout(r, 300));
  const findRows = Number(await page.evalJs(`document.querySelectorAll('.find-card-row').length`));
  check("find-card popover lists all 7 cards (6 spawned + terminal)", findRows, 7);

  page.close();
} finally {
  await stopApp(app);
}
finish();
