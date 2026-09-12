// DESIGN-BACKLOG.md §2.0 item 4 — styled scrollbar is the APP DEFAULT
// (`*` + bare ::-webkit-scrollbar*), not an opt-in `.thin-scroll` class.
//
// Verifies against a REAL Electron instance:
//   - default surfaces compute scrollbar-width: thin with zero .thin-scroll markers
//   - intentional hide classes still win over the global `*` (cascade probe + live xterm)
//   - sprint list (the reported bug surface) is thin without a manual class
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import fs from "node:fs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-scrollbar-default-${CDP_PORT}`, import.meta.url).pathname;
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

async function scrollbarInfo(page, expr) {
  return JSON.parse(
    await page.evalJs(`
      (() => {
        const el = (${expr});
        if (!el) return JSON.stringify(null);
        const cs = getComputedStyle(el);
        return JSON.stringify({
          scrollbarWidth: cs.scrollbarWidth,
          hasThinScrollClass: el.classList.contains("thin-scroll"),
        });
      })()
    `),
  );
}

async function waitFor(page, expr, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evalJs(`!!(${expr})`)) return true;
    await delay(100);
  }
  return false;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Scrollbar Default", { spawnTerminal: true });
  await delay(500);

  check("zero .thin-scroll markers in the live DOM", await page.evalJs(`document.querySelectorAll(".thin-scroll").length`), 0);

  const railInfo = await scrollbarInfo(page, `document.querySelector(".rail")`);
  check("rail has scrollbar-width: thin (global default)", railInfo?.scrollbarWidth, "thin");
  check("rail has no thin-scroll class", railInfo?.hasThinScrollClass, false);

  const xtermInfo = await scrollbarInfo(page, `document.querySelector('[data-role="terminal-body"] .xterm-viewport')`);
  check("xterm-viewport still scrollbar-width: none (live)", xtermInfo?.scrollbarWidth, "none");

  // Cascade probe: mount a throwaway node with each hide class and prove
  // it still computes `none` against the global `* { scrollbar-width: thin }`.
  // (Opening BrowserInspector via the kebab menu is flaky under headless
  // CDP in this harness; the cascade is what the task requires preserving.)
  const probes = JSON.parse(
    await page.evalJs(`
      (() => {
        const wanted = ["inspectorTabs", "deviceToolbar", "widthRulerBar"];
        const found = {};
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of rules) {
            if (!rule.selectorText || !rule.style) continue;
            if (rule.style.scrollbarWidth !== "none" && rule.style.getPropertyValue("scrollbar-width") !== "none") continue;
            for (const key of wanted) {
              if (rule.selectorText.includes(key) && !found[key]) {
                const m = rule.selectorText.match(/\\.([A-Za-z0-9_-]+)/);
                if (m) found[key] = m[1];
              }
            }
          }
        }
        const out = {};
        for (const key of wanted) {
          if (!found[key]) { out[key] = null; continue; }
          const el = document.createElement("div");
          el.className = found[key];
          el.style.overflow = "auto";
          el.style.width = "40px";
          el.style.height = "40px";
          document.body.appendChild(el);
          out[key] = { className: found[key], scrollbarWidth: getComputedStyle(el).scrollbarWidth };
          el.remove();
        }
        return JSON.stringify(out);
      })()
    `),
  );
  check("probe inspectorTabs → scrollbar-width none (beats global *)", probes.inspectorTabs?.scrollbarWidth, "none");
  check("probe deviceToolbar → scrollbar-width none (beats global *)", probes.deviceToolbar?.scrollbarWidth, "none");
  check("probe widthRulerBar → scrollbar-width none (beats global *)", probes.widthRulerBar?.scrollbarWidth, "none");

  // Visual overflow probe painted with the DEFAULT (no class) — screenshot
  const overflowProbe = await page.evalJs(`
    (() => {
      const el = document.createElement("div");
      el.id = "scrollbar-default-probe";
      el.style.cssText = "position:fixed;left:12px;top:12px;width:160px;height:120px;overflow:auto;z-index:99999;background:var(--panel);border:1px solid var(--border);color:var(--text);font:12px var(--font-mono);padding:8px;";
      el.textContent = Array.from({ length: 40 }, (_, i) => "linha de overflow " + i).join("\\n");
      document.body.appendChild(el);
      return getComputedStyle(el).scrollbarWidth;
    })()
  `);
  check("overflow probe (no class) computes thin", overflowProbe, "thin");

  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const { data: probeShot } = await page.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 12, y: 12, width: 160, height: 120, scale: 2 },
  });
  fs.writeFileSync(`${USER_DATA_DIR}/overflow-probe.png`, Buffer.from(probeShot, "base64"));
  await page.evalJs(`document.getElementById("scrollbar-default-probe")?.remove()`);

  // Task card sprint list — the surface that triggered the bug report.
  // `task` sits below the add-card popover's maxHeight; scroll + .click()
  // (not CDP coordinates on a clipped row).
  await page.evalJs(`document.querySelector('[data-role="rail-add-card"]')?.click()`);
  await delay(300);
  check("task kind in add-card popover", await waitFor(page, `document.querySelector('.popover-row[data-kind="task"]')`), true);
  const taskClick = await page.evalJs(`
    (() => {
      const row = document.querySelector('.popover-row[data-kind="task"]');
      if (!row) return "missing";
      row.scrollIntoView({ block: "nearest" });
      row.click();
      return "ok";
    })()
  `);
  check(`clicked task create row (${taskClick})`, taskClick, "ok");
  check("task card mounted", await waitFor(page, `document.querySelector('[data-part="sprints-toggle"]')`, 8000), true);

  const sprintsToggle = await centerOf(page, '[data-part="sprints-toggle"]');
  await page.click(sprintsToggle.x, sprintsToggle.y);
  check("sprints panel mounted", await waitFor(page, `document.querySelector('[data-part="sprints-panel"]')`), true);
  // Fresh board may still be fetching sprints — wait for the list OR the
  // empty/loading copy; then prefer the real `<ul>` when it appears.
  await waitFor(
    page,
    `document.querySelector('[data-part="sprints-panel"] [role="listbox"]') || document.querySelector('[data-part="sprints-panel"]')`,
    5000,
  );
  await delay(400);

  const sprintsInfo = await scrollbarInfo(
    page,
    `document.querySelector('[data-part="sprints-panel"] [role="listbox"]') || document.querySelector('[data-part="sprints-panel"] [class*="sprintsList"]')`,
  );
  if (sprintsInfo) {
    check("sprintsList scrollbar-width: thin without marker", sprintsInfo.scrollbarWidth, "thin");
    check("sprintsList has no thin-scroll class", sprintsInfo.hasThinScrollClass, false);
  } else {
    // No list yet (empty board / still loading) — cascade-probe the module class.
    const sprintProbe = JSON.parse(
      await page.evalJs(`
        (() => {
          let className = null;
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch { continue; }
            for (const rule of rules) {
              if (rule.selectorText && /sprintsList/.test(rule.selectorText) && /overflow/.test(rule.cssText)) {
                const m = rule.selectorText.match(/\\.([A-Za-z0-9_-]+)/);
                if (m) { className = m[1]; break; }
              }
            }
            if (className) break;
          }
          if (!className) return JSON.stringify(null);
          const el = document.createElement("ul");
          el.className = className;
          el.style.maxHeight = "80px";
          document.body.appendChild(el);
          const out = { className, scrollbarWidth: getComputedStyle(el).scrollbarWidth, hasThinScrollClass: el.classList.contains("thin-scroll") };
          el.remove();
          return JSON.stringify(out);
        })()
      `),
    );
    check("sprintsList class probe scrollbar-width: thin", sprintProbe?.scrollbarWidth, "thin");
    check("sprintsList class probe has no thin-scroll class", sprintProbe?.hasThinScrollClass, false);
  }

  const columnInfo = await scrollbarInfo(page, `document.querySelector('[class*="columnBody"]')`);
  check("task columnBody scrollbar-width: thin without marker", columnInfo?.scrollbarWidth, "thin");

  const clip = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector('[data-part="sprints-panel"]');
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(1, r.width), height: Math.max(1, r.height), scale: 1 });
      })()
    `),
  );
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
  });
  fs.writeFileSync(`${USER_DATA_DIR}/sprints-panel.png`, Buffer.from(data, "base64"));
  const full = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${USER_DATA_DIR}/full-board.png`, Buffer.from(full.data, "base64"));
  check("screenshots written", fs.statSync(`${USER_DATA_DIR}/overflow-probe.png`).size > 100, true);
  console.log("SHOT_DIR=" + USER_DATA_DIR);
} finally {
  await stopApp(app);
}
finish();
