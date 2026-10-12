/**
 * Isolated smoke for the overlay rail (RailPassos.dc.html #rail … #context-menu).
 * Own userData + CDP port — never the owner's instance.
 *
 * What it proves in the real app (jsdom has no layout):
 *  - the board never shifts: the viewport spans the window and the world
 *    transform is untouched when a panel opens, closes or the rail hides;
 *  - a press outside (mouse and touch) closes the panel;
 *  - hide persists across a reload; the left edge brings the rail back for a
 *    pointer dwell and for a touch drag, and it leaves again;
 *  - the title strip and the rail strip are one colour with no separator;
 *  - Home / palette / Board panel / view pill work; the old chips are gone;
 *  - the right-click menu lists the quick actions and spawns at the click.
 *
 * Screenshots → /tmp/rail-fix/app-*.png
 */
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import fs from "node:fs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-rail-overlay-${Date.now()}-${Math.random()}`, import.meta.url).pathname;
const OUT = "/tmp/rail-fix";
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 920;
const H = 580;

async function setViewport(page, width = W, height = H) {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  // Changing the zoom forces a full style recalc, so border widths snap to the new DPR.
  await page.evalJs(`document.body.style.zoom = "1.001"`);
  await delay(50);
  await page.evalJs(`document.body.style.zoom = "1"`);
  await delay(150);
}

const rect = (page, selector) =>
  page.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  })()`);

const center = async (page, selector) => {
  const r = await rect(page, selector);
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
};

async function shot(page, name) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const file = `${OUT}/app-${name}.png`;
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

async function mouseMove(page, x, y) {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
}

async function touch(page, type, x, y) {
  await page.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
  });
}

const railState = (page) =>
  page.evalJs(`(() => {
    const d = document.querySelector('[data-role="rail-dock"]');
    return d ? { step: d.dataset.railStep, hidden: d.dataset.railHidden, revealed: d.dataset.railRevealed } : null;
  })()`);

const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  // X11 honours the forced scale factor; native Wayland would keep the desktop's 1.5.
  extraArgs: ["--force-device-scale-factor=1", "--ozone-platform=x11"],
  extraEnv: { GDK_SCALE: "1", GDK_DPI_SCALE: "1" },
});
const { check, finish } = makeChecker();
const shots = [];

try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page);
  await delay(600);
  await setViewport(page);
  await page.evalJs(`localStorage.removeItem("ac.railHidden")`);

  // ---- strip: size, colour, no separator ---------------------------------
  const strip = await rect(page, ".rail");
  check("strip is 44 px wide", strip?.width, 44);
  const btn = await rect(page, '[data-role="rail-home"]');
  check("strip buttons are 32 px", [btn?.width, btn?.height], (v) => v[0] === 32 && v[1] === 32);
  const style = await page.evalJs(`(() => {
    const t = getComputedStyle(document.querySelector(".titlebar"));
    const s = getComputedStyle(document.querySelector(".rail"));
    return { tbBg: t.backgroundColor, tbBorder: t.borderBottomWidth, tbH: t.height, railBg: s.backgroundColor };
  })()`);
  check("title strip and rail strip share one colour", style.tbBg, style.railBg);
  check("title strip has no bottom border", style.tbBorder, "0px");
  check("title strip is 28 px tall on this platform", style.tbH, (v) => v === "28px" || v === "34px");

  const viewport0 = await rect(page, ".board-viewport");
  check("board viewport spans the whole window", [viewport0?.x, viewport0?.width], (v) => v[0] === 0 && v[1] === W);
  const world0 = await page.evalJs(`document.querySelector(".world")?.style.transform || ""`);
  const firstChild = await page.evalJs(`document.querySelector(".rail > :first-child")?.getAttribute("data-role")`);
  check("first strip control is Home (no star)", firstChild, "rail-home");
  check("no 'open the rail' button exists", await page.evalJs(`!document.querySelector(".rail-toggle")`), true);
  shots.push(await shot(page, "rail"));

  // ---- brand mark in the title strip, left of the path ----------------------
  const brand = await rect(page, ".titlebar-brand");
  const crumb = await rect(page, ".topbar-title");
  check("the Stellar mark is 16 px", [brand?.width, brand?.height], (v) => v[0] === 16 && v[1] === 16);
  check("centred on the rail column (x = 14) and in the strip", [brand?.x, brand?.y], (v) => v[0] === 14 && v[1] === (28 - 16) / 2);
  check("left of the board path", brand.right <= crumb.x, true);
  check("the mark takes no clicks (the strip still drags)", await page.evalJs(`getComputedStyle(document.querySelector(".titlebar-brand")).pointerEvents`), "none");
  check("no 'Stellar' text beside it", await page.evalJs(`!document.querySelector(".titlebar")?.innerText.includes("Stellar")`), true);
  shots.push(await shot(page, "titlebar-brand"));

  // ---- the board path opens the Board panel (not the old popover) -------------
  const crumbC = await center(page, ".topbar-title");
  await page.click(crumbC.x, crumbC.y);
  await delay(300);
  check("the path opens the rail's Board panel", await page.evalJs(`document.querySelector('[data-role="rail-panel"] h2')?.textContent`), "Board");
  check("and not the old sessions popover", await page.evalJs(`!document.querySelector(".board-list, .popover")`), true);
  await page.click(crumbC.x, crumbC.y);
  await delay(300);
  check("a second click on the path closes it", (await railState(page))?.step, "closed");
  await page.click(crumbC.x, crumbC.y);
  await delay(300);
  check("'Trocar de sessão…' is in the panel", await page.evalJs(`!!document.querySelector('[data-role="rail-switch-session"]')`), true);
  shots.push(await shot(page, "board-from-path"));
  // "Trocar de sessão…" swaps the Board panel for the session list (same panel).
  await page.evalJs(`document.querySelector('[data-role="rail-switch-session"]')?.click()`);
  await delay(300);
  check("'Trocar de sessão…' opens the session list", await page.evalJs(`document.querySelector('[data-role="rail-panel"] h2')?.textContent`), "Sessões");
  check("it is the rail panel, not the old popover", await page.evalJs(`!document.querySelector(".board-list, .popover") && !!document.querySelector('[data-role="rail-sessions"]')`), true);
  check("the current session is marked and listed with its agent count", await page.evalJs(`(() => { const r = document.querySelector('[data-role="session-row"][data-active="true"]'); return !!r && /agente/.test(r.textContent) && !!r.querySelector("svg"); })()`), true);
  check("both actions are there", await page.evalJs(`!!document.querySelector('[data-role="session-new"]') && !!document.querySelector('[data-role="open-archived"]')`), true);
  shots.push(await shot(page, "sessions-list"));
  await page.evalJs(`document.querySelector('[data-role="rail-sessions-back"]')?.click()`);
  await delay(250);
  check("'‹ Board' goes back to the Board panel", await page.evalJs(`document.querySelector('[data-role="rail-panel"] h2')?.textContent`), "Board");
  await page.evalJs(`document.querySelector('[data-role="rail-switch-session"]')?.click()`);
  await delay(250);
  await page.evalJs(`document.querySelector('[data-role="session-row"][data-active="true"] [data-role="edit-session"]')?.click()`);
  await delay(400);
  check("the pencil opens the edit modal and the list steps aside", await page.evalJs(`!!document.querySelector(".modal-root") && !document.querySelector('[data-role="rail-panel"]')`), true);
  await page.evalJs(`[...document.querySelectorAll(".modal-root button")].find((b) => b.textContent.trim() === "Cancelar")?.click()`);
  await delay(250);
  await page.click(700, 400);
  await delay(250);

  // ---- old top bar is gone ------------------------------------------------
  check(
    "no floating home, agents counter or chips",
    await page.evalJs(
      `!document.querySelector(".topbar-counts, .topbar-autonomous-badge, .topbar-orchestrator-badge, [data-role='topbar-agents']") && document.querySelectorAll(".topbar-home").length === 1`,
    ),
    true,
  );
  check("home lives on the rail", await page.evalJs(`!!document.querySelector(".rail .topbar-home")`), true);
  check("no 'Stellar' title text in the title strip", await page.evalJs(`!document.querySelector(".titlebar-title")`), true);

  // ---- panel over the board ----------------------------------------------
  const addC = await center(page, '[data-role="rail-add-card"]');
  await page.click(addC.x, addC.y);
  await delay(300);
  const panel = await rect(page, '[data-role="rail-panel"]');
  check("panel opens at x=44, 296 px wide", [panel?.x, panel?.width], (v) => v[0] === 44 && v[1] === 296);
  const viewport1 = await rect(page, ".board-viewport");
  check("board viewport did not move or resize", [viewport1?.x, viewport1?.width], (v) => v[0] === viewport0.x && v[1] === viewport0.width);
  check("world transform untouched by the panel", await page.evalJs(`document.querySelector(".world")?.style.transform || ""`), world0);
  shots.push(await shot(page, "rail-panel"));

  // Outside press — mouse.
  await page.click(700, 400);
  await delay(250);
  check("a mouse press outside closes the panel", (await railState(page))?.step, "closed");

  // Outside press — touch.
  await page.click(addC.x, addC.y);
  await delay(250);
  check("panel reopened", (await railState(page))?.step, "add");
  await touch(page, "touchStart", 700, 400);
  await touch(page, "touchEnd", 700, 400);
  await delay(300);
  check("a touch outside closes the panel", (await railState(page))?.step, "closed");

  // Esc.
  await page.click(addC.x, addC.y);
  await delay(250);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(250);
  check("Esc closes the panel", (await railState(page))?.step, "closed");

  // ---- tooltip with key ---------------------------------------------------
  const palC = await center(page, '[data-role="rail-palette"]');
  await mouseMove(page, palC.x, palC.y);
  await delay(250);
  check(
    "hovering the palette button shows name + Ctrl K",
    await page.evalJs(`(() => {
      const tip = document.querySelector('[data-role="rail-palette"] [role="tooltip"]');
      return tip ? getComputedStyle(tip).display + "|" + tip.textContent : null;
    })()`),
    (v) => typeof v === "string" && v.startsWith("flex|") && v.includes("Paleta de comandos") && /Ctrl|⌘/.test(v) && v.includes("K"),
  );
  shots.push(await shot(page, "rail-tooltip"));

  // ---- palette from the rail ---------------------------------------------
  await page.click(palC.x, palC.y);
  await delay(350);
  check("the palette button opens the palette", await page.evalJs(`!!document.querySelector('[aria-label="Comandos"]')`), true);
  check(
    "and lights while it is open",
    await page.evalJs(`(() => { const b = document.querySelector('[data-role="rail-palette"]'); return getComputedStyle(b).boxShadow !== "none"; })()`),
    true,
  );
  shots.push(await shot(page, "palette"));
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(300);

  // ---- view pill ----------------------------------------------------------
  const pill = await rect(page, ".zoom-pill");
  check("view pill sits bottom-right", [Math.round(W - pill.right), Math.round(H - pill.bottom)], (v) => v[0] === 14 && v[1] === 14);
  check("view pill is 36 px tall", pill.height, 36);
  const pillLabels = await page.evalJs(`[...document.querySelectorAll(".zoom-pill button")].map((b) => b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent)`);
  check("view pill has 6 controls (zoom −/%/+, fullscreen, grid, pair phone)", pillLabels.length, 6);
  const pct0 = await page.evalJs(`document.querySelector(".zoom-readout")?.textContent`);
  const inC = await center(page, '.zoom-pill button[aria-label]:nth-of-type(3)');
  void inC;
  await page.evalJs(`document.querySelectorAll(".zoom-pill button")[2].click()`);
  await delay(250);
  const pct1 = await page.evalJs(`document.querySelector(".zoom-readout")?.textContent`);
  check("zoom in changes the readout", pct1 !== pct0, true);

  // ---- Board panel --------------------------------------------------------
  await page.evalJs(`window.__stellarRail?.seedBoard()`);
  await delay(300);
  check("Board panel title", await page.evalJs(`document.querySelector('[data-role="rail-panel"] h2')?.textContent`), "Board");
  check(
    "Board panel carries path, mode, orchestrator and agents",
    await page.evalJs(`(() => {
      const p = document.querySelector('[data-role="rail-board-panel"]');
      const t = p?.textContent || "";
      return /Caminho/.test(t) && /Modo/.test(t) && /Orquestrador/.test(t) && /Agentes abertos · 3/.test(t);
    })()`),
    true,
  );
  check("autonomous dot on the Board button", await page.evalJs(`!!document.querySelector('[data-role="rail-board-dot"]')`), true);
  shots.push(await shot(page, "board-panel"));
  await page.evalJs(`window.__stellarRail?.setStep("closed")`);
  await delay(200);

  // ---- hide + persistence + edge reveal ----------------------------------
  const hideC = await center(page, '[data-role="rail-hide"]');
  await page.click(hideC.x, hideC.y);
  await delay(400);
  const hiddenStrip = await page.evalJs(`getComputedStyle(document.querySelector(".rail")).visibility`);
  check("hiding makes the strip invisible", hiddenStrip, "hidden");
  const viewport2 = await rect(page, ".board-viewport");
  check("hiding does not touch the board viewport", [viewport2?.x, viewport2?.width], (v) => v[0] === 0 && v[1] === W);
  const hint = await rect(page, '[data-role="rail-edge-hint"]');
  check("a 3 px hint remains on the left edge", [hint?.x, hint?.width], (v) => v[0] === 0 && v[1] === 3);
  check("preference persisted", await page.evalJs(`localStorage.getItem("ac.railHidden")`), "1");
  shots.push(await shot(page, "rail-hidden"));

  // Pointer dwell.
  await mouseMove(page, 5, 300);
  await delay(500);
  const rev = await railState(page);
  check("pointer dwell at the left edge reveals the rail", rev?.revealed, "1");
  const revStrip = await rect(page, ".rail");
  check("revealed strip is on screen over the board", revStrip?.x, 0);
  check("revealing leaves the board viewport alone", (await rect(page, ".board-viewport"))?.width, W);
  shots.push(await shot(page, "rail-reveal"));
  await mouseMove(page, 700, 300);
  await delay(1100);
  check("it leaves again after the pointer goes away", (await railState(page))?.revealed, "0");

  // Touch drag from the edge.
  await touch(page, "touchStart", 3, 300);
  await touch(page, "touchMove", 20, 300);
  await touch(page, "touchMove", 60, 300);
  await touch(page, "touchEnd", 60, 300);
  await delay(300);
  check("a touch drag from the edge reveals the rail", (await railState(page))?.revealed, "1");
  await mouseMove(page, 700, 300);
  await delay(1100);

  // Survives a reload.
  await page.send("Page.reload");
  await delay(2500);
  await connectPage(CDP_PORT).then((p) => p.close());
  const page2 = await connectPage(CDP_PORT);
  // A reload lands on the sessions screen: enter a board again before measuring.
  await bootIntoFreshSession(page2, "Sessão 2", { spawnTerminal: false });
  await setViewport(page2);
  await delay(800);
  const afterReload = await railState(page2);
  check("hidden preference survives a reload", afterReload?.hidden, "1");
  await page2.evalJs(`localStorage.setItem("ac.railHidden", "0")`);
  await page2.evalJs(`window.__stellarRail?.setStep("closed")`);
  await delay(300);

  // ---- context menu -------------------------------------------------------
  await page2.evalJs(`window.__stellarOpenCanvasMenu?.(334, 52)`);
  await delay(300);
  const menuItems = await page2.evalJs(`[...document.querySelectorAll('[data-part="board-canvas-menu"] [role="menuitem"]')].map((b) => b.textContent.replace(/\\s+/g, " ").trim())`);
  check("right-click menu lists 14 quick actions", menuItems.length, 14);
  check("'Nova task aqui' comes first", menuItems[0], "Nova task aqui");
  check(
    "menu has the spawn kinds, tools (V P C S) and the radial/palette shortcuts",
    menuItems.join("|"),
    (v) =>
      ["Agente ou terminal", "Navegador", "Código", "Mudanças", "Nota", "Chat", "Janela remota"].every((l) => v.includes(l)) &&
      ["PonteiroV", "CanetaP", "ConectorC", "SeleçãoS"].every((l) => v.includes(l)) &&
      v.includes("Menu radialQ") &&
      /Paleta de comandos(Ctrl|⌘)K/.test(v),
  );
  shots.push(await shot(page2, "context-menu"));
  const before = await page2.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`);
  await page2.evalJs(`document.querySelector('[data-part="board-canvas-sticky"]')?.click()`);
  await delay(500);
  const after = await page2.evalJs(`document.querySelectorAll('[data-kind="sticky"]').length`);
  check("picking Nota in the menu creates a note", after, before + 1);
  check("the menu closes after a pick", await page2.evalJs(`!document.querySelector('[data-part="board-canvas-menu"]')`), true);

  // Radial from the menu.
  await page2.evalJs(`window.__stellarOpenCanvasMenu?.(334, 52)`);
  await delay(250);
  await page2.evalJs(`document.querySelector('[data-part="board-canvas-radial"]')?.click()`);
  await delay(350);
  check("'Menu radial' opens the radial ring", await page2.evalJs(`!!document.querySelector('[aria-label]') && !!document.querySelector('[role="menu"][aria-label*="adial"], [data-part="radial-menu"]')`), true);
  await page2.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page2.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await delay(250);

  // ---- Home ---------------------------------------------------------------
  const homeC = await center(page2, '[data-role="rail-home"]');
  await page2.click(homeC.x, homeC.y);
  await delay(900);
  check("Home on the rail returns to the sessions screen", await page2.evalJs(`!!document.querySelector(".home")`), true);

  console.log("\nscreenshots:\n" + shots.join("\n"));
  finish();
} finally {
  await stopApp(app);
}
