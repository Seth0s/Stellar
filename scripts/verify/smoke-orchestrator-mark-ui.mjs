// Board orchestrator mark — UI gesture → SQLite.
// Clicks the terminal ⋮ menu → confirm → asserts boards.orchestrator_card_id,
// then clears via the same menu and asserts NULL. No MCP shortcut: the
// mark is deliberately UI-only (preload comment, store write path).
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-orchestrator-mark-${CDP_PORT}`, import.meta.url)
  .pathname;
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function readOrchestratorColumn() {
  const db = new Database(join(USER_DATA_DIR, "agent-canvas.db"), { readonly: true });
  try {
    const rows = db.prepare("SELECT id, orchestrator_card_id FROM boards").all();
    return rows;
  } finally {
    db.close();
  }
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Orch Mark UI");
  await new Promise((r) => setTimeout(r, 800));

  const before = readOrchestratorColumn();
  check("board starts unmarked", before.every((r) => r.orchestrator_card_id == null), true);

  // Open the terminal card ⋮ menu and click "Mark as board orchestrator…"
  // Prefer DOM .click() over coordinate hits: Popover may render in a
  // portal whose getBoundingClientRect is zero until layout settles, and
  // a miss silently closes the menu.
  const opened = await page.evalJs(`
    (() => {
      const menuBtn = document.querySelector('[data-role="terminal-card-menu"]');
      if (!menuBtn) return JSON.stringify({ ok: false, why: "no-menu-btn" });
      menuBtn.click();
      return JSON.stringify({ ok: true });
    })()
  `);
  check("opened terminal card menu", JSON.parse(opened).ok, true);
  await new Promise((r) => setTimeout(r, 400));

  const markClick = await page.evalJs(`
    (() => {
      const mark = document.querySelector('[data-role="terminal-mark-orchestrator"]');
      if (!mark) {
        const pop = document.querySelector('[data-role="terminal-card-menu-popover"]');
        return JSON.stringify({
          ok: false,
          why: "no-mark-btn",
          popoverHtml: pop ? pop.innerHTML.slice(0, 400) : null,
          menuOpen: !!pop,
        });
      }
      mark.click();
      return JSON.stringify({ ok: true });
    })()
  `);
  const markResult = JSON.parse(markClick);
  if (!markResult.ok) console.error("markClick dump:", markClick);
  check("clicked mark-orchestrator menu item", markResult.ok, true);
  await new Promise((r) => setTimeout(r, 400));

  // ConfirmModal — primary (non-danger) confirm button.
  const confirmClick = await page.evalJs(`
    (() => {
      const btn = document.querySelector('.modal-actions button.primary');
      if (!btn) return JSON.stringify({ ok: false, why: "no-confirm", modals: document.querySelectorAll('.modal').length });
      btn.click();
      return JSON.stringify({ ok: true, label: btn.textContent });
    })()
  `);
  check("confirmed mark in ConfirmModal", JSON.parse(confirmClick).ok, true);
  await new Promise((r) => setTimeout(r, 500));

  const cardId = JSON.parse(
    await page.evalJs(`
      JSON.stringify(
        document.querySelector('[data-role="terminal-activity"]')?.getAttribute("data-card-id")
          || document.querySelector('[data-kind="terminal"]')?.getAttribute("data-id")
      )
    `),
  );
  check("resolved the terminal card id from the DOM", typeof cardId === "string" && cardId.length > 0, true);

  const afterMark = readOrchestratorColumn();
  const marked = afterMark.find((r) => r.orchestrator_card_id === cardId);
  check("SELECT boards.orchestrator_card_id equals the marked card after UI confirm", !!marked, true);
  console.log("LIVE_PROOF mark:", JSON.stringify(afterMark));

  const badge = JSON.parse(
    await page.evalJs(`JSON.stringify(!!document.querySelector('[data-role="terminal-orchestrator-badge"]'))`),
  );
  check("card shows orchestrator badge after mark", badge, true);

  const topbar = JSON.parse(
    await page.evalJs(`JSON.stringify(!!document.querySelector('[data-role="topbar-orchestrator-badge"]'))`),
  );
  check("topbar shows orchestrator badge after mark", topbar, true);

  // Clear via the same menu surface. Use DOM .click() — CDP mouse
  // pressed/released can open then immediately close the Popover
  // (mouseup lands as an outside click). Same pattern as the mark step.
  let menuOpen = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evalJs(`document.querySelector('[data-role="terminal-card-menu"]')?.click()`);
    await new Promise((r) => setTimeout(r, 300));
    menuOpen = JSON.parse(
      await page.evalJs(`JSON.stringify(!!document.querySelector('[data-role="terminal-card-menu-popover"]'))`),
    );
    if (menuOpen) break;
  }
  check("re-opened terminal card menu for clear", menuOpen, true);
  const clearClick = await page.evalJs(`
    (() => {
      const clear = document.querySelector('[data-role="terminal-clear-orchestrator"]');
      if (!clear) {
        const pop = document.querySelector('[data-role="terminal-card-menu-popover"]');
        return JSON.stringify({
          ok: false,
          why: "no-clear",
          popoverHtml: pop ? pop.innerHTML.slice(0, 500) : null,
          isOrchBadge: !!document.querySelector('[data-role="terminal-orchestrator-badge"]'),
        });
      }
      clear.click();
      return JSON.stringify({ ok: true });
    })()
  `);
  if (!JSON.parse(clearClick).ok) console.error("clearClick dump:", clearClick);
  check("clicked clear-orchestrator menu item", JSON.parse(clearClick).ok, true);
  await new Promise((r) => setTimeout(r, 500));

  const afterClear = readOrchestratorColumn();
  check(
    "SELECT boards.orchestrator_card_id is NULL after clear",
    afterClear.every((r) => r.orchestrator_card_id == null),
    true,
  );
  console.log("LIVE_PROOF clear:", JSON.stringify(afterClear));

  const badgeGone = JSON.parse(
    await page.evalJs(`JSON.stringify(!document.querySelector('[data-role="terminal-orchestrator-badge"]'))`),
  );
  check("card badge gone after clear", badgeGone, true);
} finally {
  await stopApp(app);
}
finish();
