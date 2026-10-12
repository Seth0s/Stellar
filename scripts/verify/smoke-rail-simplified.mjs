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

  const btnCount = await page.evalJs(`document.querySelectorAll(".rail .rail-btn").length`);
  check("rail strip has icon buttons", btnCount >= 9, true);

  const addBtn = await centerOf(page, `[data-role="rail-add-card"]`);
  check("add card button exists", !!addBtn, true);

  await page.click(addBtn.x, addBtn.y);
  await delay(400);

  const panelTitle = await page.evalJs(`document.querySelector('[data-role="rail-panel"] h2')?.textContent`);
  check("add card panel opened", panelTitle, "Novo card");

  const zoomBefore = await page.evalJs(`document.querySelector(".world")?.style.transform || ""`);
  await page.evalJs(`
    (() => {
      const panel = document.querySelector('[data-role="rail-panel"]');
      panel?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
    })()
  `);
  await delay(200);
  const zoomAfter = await page.evalJs(`document.querySelector(".world")?.style.transform || ""`);
  check("canvas zoom is unchanged when wheeling inside the rail panel", zoomAfter, zoomBefore);

  const optionCount = await page.evalJs(`document.querySelectorAll('[data-role="rail-panel"] [data-kind]').length`);
  check("panel lists terminal hero + 6 card kinds", optionCount, 7);

  const filesOption = await centerOf(page, `[data-role="rail-panel"] [data-kind="files"]`);
  check("files card option exists in panel", !!filesOption, true);
  await page.click(filesOption.x, filesOption.y);
  await delay(400);

  const filesCardExists = await page.evalJs(`!!document.querySelector(".files-card")`);
  check("files card was spawned after selecting from panel", filesCardExists, true);

  await page.click(addBtn.x, addBtn.y);
  await delay(350);
  const terminalOption = await centerOf(page, `[data-role="rail-panel"] [data-kind="terminal"]`);
  check("terminal option exists in panel", !!terminalOption, true);
  await page.click(terminalOption.x, terminalOption.y);
  await delay(300);

  const step1 = await page.evalJs(`document.querySelector('[data-role="rail-dock"]')?.getAttribute("data-rail-step")`);
  check("terminal step 1 opened", step1, "terminal1");

  await page.evalJs(`window.__stellarRail?.setStep("terminal2")`);
  await delay(200);
  const primary = await page.evalJs(`
    (() => {
      const buttons = [...document.querySelectorAll('[data-role="rail-panel"] button')];
      const b = buttons.find((el) => /Abrir o card/i.test(el.textContent || ""));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
  check("create terminal button exists", !!primary, true);
  await page.click(primary.x, primary.y);
  await delay(400);

  const terminalCardCount = await page.evalJs(`document.querySelectorAll('[data-kind="terminal"]').length`);
  check("new terminal card was created (seeded + newly created = 2)", terminalCardCount, 2);

  // The rail has no "open" control any more — only a hide button; the left edge brings it back.
  check("no open/collapse toggle remains", await page.evalJs(`!document.querySelector(".rail-toggle")`), true);
  const hideBtn = await centerOf(page, '[data-role="rail-hide"]');
  check("hide button is present", !!hideBtn, true);
  await page.click(hideBtn.x, hideBtn.y);
  await delay(400);
  const hidden = await page.evalJs(`document.querySelector('[data-role="rail-dock"]')?.getAttribute("data-rail-hidden") === "1"`);
  check("rail hidden", hidden, true);
  await page.evalJs(`window.__stellarRail?.setStep("closed")`);
  await delay(300);
  const shown = await page.evalJs(`document.querySelector('[data-role="rail-dock"]')?.getAttribute("data-rail-hidden") === "0"`);
  check("seed API shows it again for the rest of the suite", shown, true);

  finish();
} finally {
  await stopApp(app);
}
