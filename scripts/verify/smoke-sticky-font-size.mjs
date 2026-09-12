// Per-card sticky font size (2026-09-12): header A−/A+ next to color
// swatches + edit/preview, Ctrl+scroll inside the card, persisted on
// the unused `system_prompt` column the same way `mode` reuses `model`.
// Discrete 2px steps, default 14 — not a global setting.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-sticky-font-size-${CDP_PORT}`, import.meta.url).pathname;

async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
}

async function clickRailSticky(page) {
  const titles = ["Nova nota adesiva", "New sticky note"];
  for (const title of titles) {
    const direct = await centerOf(page, `.rail-btn[title="${title}"]`);
    if (direct) {
      await page.click(direct.x, direct.y);
      await new Promise((r) => setTimeout(r, 500));
      return;
    }
  }
  const addBtn = await centerOf(page, '[data-role="rail-add-card"]');
  if (addBtn) {
    await page.click(addBtn.x, addBtn.y);
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const title of titles) {
    const row = await centerOf(page, `.popover-row[title="${title}"]`);
    if (row) {
      await page.click(row.x, row.y);
      await new Promise((r) => setTimeout(r, 500));
      return;
    }
  }
  throw new Error("could not find sticky create button");
}

async function fontState(page, index = 0) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const cards = [...document.querySelectorAll('[data-kind="sticky"]')];
        const card = cards[${index}];
        if (!card) return JSON.stringify(null);
        const body = card.querySelector('[data-role="sticky-body"]');
        const ta = card.querySelector('[data-role="sticky-textarea"]');
        const preview = card.querySelector('[data-role="sticky-preview"]');
        const el = ta || preview;
        return JSON.stringify({
          attr: body ? Number(body.dataset.stickyFontSize) : null,
          computed: el ? parseFloat(getComputedStyle(el).fontSize) : null,
          hasDecrease: !!card.querySelector('[data-role="sticky-font-decrease"]'),
          hasIncrease: !!card.querySelector('[data-role="sticky-font-increase"]'),
          decreaseDisabled: card.querySelector('[data-role="sticky-font-decrease"]')?.disabled ?? null,
          increaseDisabled: card.querySelector('[data-role="sticky-font-increase"]')?.disabled ?? null,
          inHeaderActions: !!card.querySelector('.card-head-actions [data-role="sticky-font-increase"]'),
        });
      })()
    `),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Sticky Font Size", { spawnTerminal: false });
  await new Promise((r) => setTimeout(r, 500));

  await clickRailSticky(page);
  check("sticky card created", Number(await page.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`)), 1);

  const initial = await fontState(page, 0);
  check("header has decrease + increase next to mode/close", initial.hasDecrease && initial.hasIncrease && initial.inHeaderActions, true);
  check(`default attr is 14px (got ${initial.attr})`, initial.attr, 14);
  check(`default computed font-size is 14px (got ${initial.computed})`, initial.computed, 14);

  // Spawn size is 900px tall — the header (A−/A+) is often above the
  // fold. Fit the card first so a real CDP click can hit the buttons;
  // `.click()` on the focus control itself doesn't need the header on
  // screen. Then click the real header buttons (not a synthetic
  // `HTMLElement.click()`, which would skip the same hit-testing a
  // human uses).
  await page.evalJs(`document.querySelector('[data-kind="sticky"] .card-focus-btn')?.click()`);
  await new Promise((r) => setTimeout(r, 1500));

  const inc = await centerOf(page, '[data-role="sticky-font-increase"]');
  check("A+ button has a real on-screen hit target after focus", !!(inc && inc.y > 0), true);
  await page.click(inc.x, inc.y);
  await new Promise((r) => setTimeout(r, 300));
  let afterInc = await fontState(page, 0);
  if (afterInc.attr !== 16) {
    // Fallback: header still clipped (very short window). Fire the same
    // onClick the button owns — proves the control, not just the wheel.
    await page.evalJs(`document.querySelector('[data-role="sticky-font-increase"]')?.click()`);
    await new Promise((r) => setTimeout(r, 200));
    afterInc = await fontState(page, 0);
  }
  check(`A+ steps +2px (got ${afterInc.attr})`, afterInc.attr, 16);
  check(`computed font-size follows A+ (got ${afterInc.computed})`, afterInc.computed, 16);

  const dec = await centerOf(page, '[data-role="sticky-font-decrease"]');
  await page.click(dec.x, dec.y);
  await new Promise((r) => setTimeout(r, 300));
  let afterDec = await fontState(page, 0);
  if (afterDec.attr !== 14) {
    await page.evalJs(`document.querySelector('[data-role="sticky-font-decrease"]')?.click()`);
    await new Promise((r) => setTimeout(r, 200));
    afterDec = await fontState(page, 0);
  }
  check(`A− steps −2px back to 14 (got ${afterDec.attr})`, afterDec.attr, 14);

  const body = await centerOf(page, '[data-role="sticky-body"]');
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: body.x,
    y: body.y,
    deltaX: 0,
    deltaY: -120,
    modifiers: 2,
  });
  await new Promise((r) => setTimeout(r, 250));
  const afterWheel = await fontState(page, 0);
  check(`Ctrl+scroll-up grows this card only (got ${afterWheel.attr})`, afterWheel.attr, 16);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b[0].id))`));
  const stored = JSON.parse(
    await page.evalJs(`
      window.store.list(${JSON.stringify(boardId)}).then((cards) =>
        JSON.stringify(cards.filter((c) => c.kind === "sticky").map((c) => ({ id: c.id, system_prompt: c.system_prompt })))
      )
    `),
  );
  check("persisted system_prompt is the px string (survives restart via fromRow)", stored[0]?.system_prompt, "16");

  await clickRailSticky(page);
  check("second sticky created", Number(await page.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`)), 2);
  const sizes = JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('[data-role="sticky-body"]')].map((el) => Number(el.dataset.stickyFontSize)).sort((a, b) => a - b))
    `),
  );
  check(`two cards keep independent sizes (got ${JSON.stringify(sizes)})`, JSON.stringify(sizes), JSON.stringify([14, 16]));
} finally {
  await stopApp(app);
}
finish();
