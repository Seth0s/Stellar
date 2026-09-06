import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

import fs from "node:fs";

const CDP_PORT = 9500 + Math.floor(Math.random() * 400);
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-rail-${Date.now()}-${Math.random()}`, import.meta.url).pathname;
fs.mkdirSync(USER_DATA_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function centerOf(page, selector) {
  return await page.evalJs(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
const { check, finish } = makeChecker();

try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page);

  // 1. Check rail rendered with compact button count (5 tools + 1 add + 3 actions = 9 buttons)
  const btnCount = await page.evalJs(`document.querySelectorAll(".rail .rail-btn").length`);
  check("rail has 9 compact buttons (5 tools + 1 add card + 3 actions)", btnCount, 9);

  // 2. Check add card button exists
  const addBtn = await centerOf(page, `[data-role="rail-add-card"]`);
  check("add card button exists", !!addBtn, true);

  // 3. Click add card button to open popover
  await page.click(addBtn.x, addBtn.y);
  await delay(400);

  const popoverHeading = await page.evalJs(`document.querySelector(".popover .board-list-heading")?.textContent`);
  check("add card popover opened with heading", popoverHeading, "ADICIONAR AO CANVAS");

  // 3.1 Verify wheel event over popover does NOT zoom the canvas
  const zoomBefore = await page.evalJs(`
    (() => {
      const world = document.querySelector(".world");
      return world?.style.transform || "";
    })()
  `);

  await page.evalJs(`
    (() => {
      const pop = document.querySelector(".popover");
      pop?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
    })()
  `);
  await delay(200);

  const zoomAfter = await page.evalJs(`
    (() => {
      const world = document.querySelector(".world");
      return world?.style.transform || "";
    })()
  `);
  check("canvas zoom is unchanged when wheeling inside the popover", zoomAfter, zoomBefore);

  const optionCount = await page.evalJs(`document.querySelectorAll(".popover .popover-row").length`);
  check("popover lists all 7 card kinds", optionCount, 7);

  // 4. Click files card option
  const filesOption = await centerOf(page, `.popover .popover-row[data-kind="files"]`);
  check("files card option exists in popover", !!filesOption, true);
  await page.click(filesOption.x, filesOption.y);
  await delay(400);

  const filesCardExists = await page.evalJs(`!!document.querySelector(".files-card")`);
  check("files card was spawned after selecting from popover", filesCardExists, true);

  const popoverClosed = await page.evalJs(`!document.querySelector(".popover")`);
  check("popover closed after card creation", popoverClosed, true);

  // 5. Test Terminal configuration flow in Popover
  await page.click(addBtn.x, addBtn.y);
  await delay(350);
  const terminalOption = await centerOf(page, `.popover .popover-row[data-kind="terminal"]`);
  check("terminal option exists in popover", !!terminalOption, true);
  await page.click(terminalOption.x, terminalOption.y);
  await delay(300);

  const terminalConfigHeading = await page.evalJs(`document.querySelector(".popover .popover-header-with-back .board-list-heading")?.textContent?.trim()`);
  check("terminal config view opened in popover", terminalConfigHeading, "NOVO TERMINAL");

  const createTerminalBtn = await centerOf(page, `.popover .popover-actions button.primary`);
  check("create terminal button exists", !!createTerminalBtn, true);
  await page.click(createTerminalBtn.x, createTerminalBtn.y);
  await delay(400);

  const terminalCardCount = await page.evalJs(`document.querySelectorAll('[data-kind="terminal"]').length`);
  check("new terminal card was created (seeded + newly created = 2)", terminalCardCount, 2);

  // 6. Test collapse / expand toggle with fluid animation & subtle state
  const toggleBtn = await centerOf(page, ".rail-toggle");
  check("toggle button is present", !!toggleBtn, true);

  // Collapse
  await page.click(toggleBtn.x, toggleBtn.y);
  await delay(400);

  const isCollapsed = await page.evalJs(`document.querySelector(".rail-container")?.classList.contains("is-collapsed")`);
  check("rail container has is-collapsed class", isCollapsed, true);

  const toggleTitleCollapsed = await page.evalJs(`document.querySelector(".rail-toggle")?.getAttribute("title")`);
  check("toggle title updated to Mostrar barra lateral", toggleTitleCollapsed, "Mostrar barra lateral");

  // Expand back
  const toggleBtnCollapsed = await centerOf(page, ".rail-toggle");
  check("toggle button collapsed is present", !!toggleBtnCollapsed, true);
  await page.click(toggleBtnCollapsed.x, toggleBtnCollapsed.y);
  await delay(400);

  const isExpanded = await page.evalJs(`!document.querySelector(".rail-container")?.classList.contains("is-collapsed")`);
  check("rail container is expanded back", isExpanded, true);

  finish();
} finally {
  await stopApp(app);
}
