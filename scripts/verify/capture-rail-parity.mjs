/**
 * Prototype × app parity for the overlay rail, by getComputedStyle.
 *
 * Both sides are measured at 920×580 / deviceScaleFactor 1:
 *   proto — docs/design/app-v3/prototipo/RailPassos.dc.html (the `[data-frame]` windows)
 *   app   — an isolated build driven into the same state with the prototype's mock facts
 *           (window.__stellarRail seeds; mock board = Demo project / Sprint board / Agent A-C)
 *
 * Writes /tmp/rail-fix/parity-table.md, parity.json, app-parity-<frame>.png,
 * proto-<frame>.png and side-by-side-<frame>.png. Exit 1 on any divergent value.
 */
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const OUT = "/tmp/rail-fix";
const PROTO_DIR = fileURLToPath(new URL("../../docs/design/app-v3/prototipo/", import.meta.url));
const USER_DATA_DIR = new URL(`../../.verify-tmp/capture-rail-parity-${Date.now()}-${Math.random()}`, import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// The prototype windows are 920×580 border-box with a 1 px border, so their drawing area is 918×578.
const W = 918;
const H = 578;

const BOX = ["@width", "@height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "backgroundColor", "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth", "borderTopColor", "borderRightColor", "borderBottomColor", "borderTopLeftRadius"];
const FLEX = ["flexDirection", "alignItems", "gap"];
const TEXT = ["fontSize", "fontWeight", "color", "letterSpacing", "textTransform"];
const BTN = ["@width", "@height", "borderTopLeftRadius", "backgroundColor", "color"];

const strip = [
  ["strip", "nav", ".rail", [...BOX, ...FLEX, "boxShadow"]],
  ["home", 'button[aria-label="Início (voltar às sessões)"]', '[data-role="rail-home"]', BTN],
  ["button · pointer (lit)", 'button[aria-label="Ponteiro (V)"]', '.rail [aria-label="Ponteiro (V)"]', [...BTN, "boxShadow"]],
  ["button · pen", 'button[aria-label="Caneta (P)"]', '.rail [aria-label="Caneta (P)"]', BTN],
  ["button · palette", 'button[aria-label="Paleta de comandos (Ctrl K)"]', '[data-role="rail-palette"]', BTN],
  ["button · settings", 'button[aria-label="Configurações"]', '[data-role="rail-settings"]', BTN],
  ["button · hide", 'button[aria-label="Esconder a barra"]', '[data-role="rail-hide"]', BTN],
  ["button · board", 'button[aria-label="Board e sessão"]', '[data-role="rail-board"]', BTN],
  ["divider", 'nav > span[aria-hidden="true"]', '.rail > span[aria-hidden="true"]', ["@width", "@height", "backgroundColor", "marginTop", "marginBottom"]],
  ["board dot", 'nav button[aria-label="Board e sessão"] > span', '[data-role="rail-board-dot"]', ["@width", "@height", "backgroundColor", "borderTopLeftRadius"]],
  ["view pill", '[role="toolbar"]', ".zoom-pill", [...BOX, "gap", "boxShadow"]],
  ["pill · zoom out", "[role=toolbar] button:nth-of-type(1)", ".zoom-pill button:nth-of-type(1)", ["@width", "@height", "borderTopLeftRadius", "color"]],
  ["pill · readout", "[role=toolbar] button:nth-of-type(2)", ".zoom-pill button:nth-of-type(2)", ["@height", ...TEXT, "fontFamily"]],
  ["pill · fullscreen", "[role=toolbar] button:nth-of-type(4)", ".zoom-pill button:nth-of-type(4)", ["@width", "@height", "color"]],
  ["pill · divider", "[role=toolbar] > span", ".zoom-pill > span", ["@width", "@height", "backgroundColor"]],
  ["titlebar", '[data-part="titlebar"]', ".titlebar", ["@height", "backgroundColor", "borderBottomWidth"]],
  ["window control", '[data-part="winctl"]', ".titlebar-controls button", ["@width", "@height", "color"]],
];

const FRAMES = [
  {
    id: "rail",
    pairs: [
      ...strip,
      ["tooltip", '[data-part="tip"]', '[data-role="rail-palette"] [role="tooltip"]', [...BOX.slice(2), ...TEXT, "@height", "gap", "boxShadow"]],
    ],
  },
  {
    id: "rail-panel",
    pairs: [
      ["panel", 'section[aria-label="Novo card"]', '[data-role="rail-panel"]', ["@width", "backgroundColor", "borderRightWidth", "borderRightColor", "boxShadow", "@x"]],
      ["panel header", "section > header", '[data-role="rail-panel"] > header', ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderBottomWidth", "borderBottomColor", "@height"]],
      ["panel title", "section > header > h2", '[data-role="rail-panel"] h2', TEXT],
      ["panel hint", "section > header > span:last-child", '[data-role="rail-panel"] > header > div > span:last-child', ["fontSize", "color"]],
      ["panel body", "section > div", '[data-role="rail-panel"] > div:last-child', ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "gap", "flexDirection"]],
      ["hero tile", "section .rpt", '[data-kind="terminal"]', [...BOX, "gap", "@height"]],
      ["hero title", "section .rpt > span:first-child", '[data-kind="terminal"] > span:first-child', [...TEXT, "gap"]],
      ["hero meta", "section .rpt > span:nth-child(2)", '[data-kind="terminal"] > span:nth-child(2)', ["fontSize", "color", "gap"]],
      ["tile grid", 'section div[style*="grid-template-columns"]', 'div:has(> [data-kind="browser"])', ["gap", "@width"]],
      ["grid tile", 'section div[style*="grid-template-columns"] > .rpt', '[data-kind="browser"]', [...BOX, "gap", "@height"]],
      ["grid tile title", 'section div[style*="grid-template-columns"] > .rpt > span:first-child', '[data-kind="browser"] > span:first-child', TEXT],
      ["grid tile desc", 'section div[style*="grid-template-columns"] > .rpt > span:nth-child(2)', '[data-kind="browser"] > span:nth-child(2)', ["fontSize", "color"]],
      ["footnote", "section > div > span:last-child", '[data-role="rail-panel"] > div:last-child > span:last-child', ["fontSize", "color"]],
      ["kbd", "section .rpt > span:nth-child(2) .rpk:last-of-type", '[data-kind="terminal"] > span:nth-child(2) > span:last-child', ["@width", "@height", "fontSize", "fontWeight", "color", "backgroundColor", "borderTopColor", "borderBottomWidth", "borderTopLeftRadius"]],
      ["button · add (lit)", 'button[aria-label="Novo card"]', '[data-role="rail-add-card"]', [...BTN, "boxShadow"]],
    ],
  },
  {
    id: "rail-hidden",
    pairs: [["edge hint", ":scope > span[aria-hidden]", '[data-role="rail-edge-hint"]', ["@width", "@height", "backgroundColor", "borderTopRightRadius"]]],
  },
  {
    id: "rail-reveal",
    pairs: [["revealed strip", "nav", ".rail", ["@width", "backgroundColor", "boxShadow", "@x"]]],
  },
  {
    id: "context-menu",
    pairs: [
      ["menu", '[role="menu"]', '[data-part="board-canvas-menu"]', [...BOX, "@x", "@y", "boxShadow", "flexDirection"]],
      ["item · first (active)", '[role="menu"] > div:nth-of-type(1)', '[data-part="board-canvas-new-task"]', ["@height", "paddingLeft", "gap", "fontSize", "color", "backgroundColor", "borderTopLeftRadius"]],
      ["item · plain", '[role="menu"] > div:nth-of-type(2)', '[data-part="board-canvas-terminal"]', ["@height", "paddingLeft", "gap", "fontSize", "color", "backgroundColor", "borderTopLeftRadius"]],
      ["separator", '[role="menu"] > span:nth-of-type(1)', '[role="menu"] > div:nth-of-type(2) > span:nth-of-type(1)', ["@height", "backgroundColor", "marginTop", "marginLeft"]],
      ["section label", '[role="menu"] > span:nth-of-type(2)', '[role="menu"] > div:nth-of-type(2) > span:nth-of-type(2)', ["fontSize", "fontWeight", "color", "letterSpacing", "@text", "fontFamily", "paddingTop", "paddingLeft", "paddingBottom"]],
      ["kbd", '[role="menu"] .rpk', '[data-part="board-canvas-tool-pointer"] > span:last-child', ["@width", "@height", "fontSize", "color", "backgroundColor", "borderTopColor", "borderBottomWidth"]],
    ],
  },
  {
    id: "palette",
    pairs: [["button · palette (lit)", 'button[aria-label="Paleta de comandos (Ctrl K)"]', '[data-role="rail-palette"]', [...BTN, "boxShadow"]]],
  },
  {
    id: "no-topbar-a",
    pairs: [
      ["crumb", '[data-part="crumb"]', ".topbar-title", ["@x", ...TEXT.slice(0, 3), "gap"]],
      ["crumb · current board", '[data-part="crumb"] strong', ".topbar-title strong", ["fontWeight", "color"]],
    ],
  },
  {
    id: "titlebar-brand-win",
    pairs: [
      ["brand mark", '[data-part="brand"]', ".titlebar-brand", ["@x", "@y", "@width", "@height"]],
      ["crumb (after the mark)", '[data-part="crumb"]', ".topbar-title", ["@x", "fontSize", "color"]],
    ],
  },
  {
    id: "no-topbar-b",
    pairs: [
      ["board row", '[data-part="brow"]', '[data-role="rail-board-panel"] > div:nth-child(1)', ["@width", "paddingTop", "paddingLeft", "gap", "backgroundColor", "borderTopLeftRadius", "flexDirection"]],
      ["row label", '[data-part="blabel"]', '[data-role="rail-board-panel"] > div:nth-child(1) > span:first-child', TEXT],
      ["autonomous chip", '[data-part="bchip"]', '[data-role="rail-board-autonomous"] > span:first-child', [...TEXT, "borderTopWidth", "borderTopColor", "borderTopLeftRadius", "paddingTop", "paddingLeft"]],
      ["agent row", '[data-part="bagent"]', '[data-role="topbar-agent-row"]', ["gap", "fontSize", "color"]],
      ["agent status", '[data-part="bagent"] > span:last-child', '[data-role="topbar-agent-row"] > span:last-child', ["fontSize", "color"]],
      ["panel title", "section > header > h2", '[data-role="rail-panel"] h2', TEXT],
    ],
  },
  {
    id: "rail-sessions-list",
    pairs: [
      ["panel title", "section > header h2", '[data-role="rail-panel"] h2', TEXT],
      ["panel hint", "section > header > div > span:last-child", '[data-role="rail-panel"] > header > div > span:last-child', ["fontSize", "color"]],
      ["back link", "section > div > button:first-child", '[data-role="rail-sessions-back"]', [...TEXT, "@x", "@y"]],
      ["group head", '[data-part="sh"]', '[data-role="rail-sessions"] > div:nth-child(2) > div:nth-child(1) > span', [...TEXT, "paddingBottom", "letterSpacing", "textTransform"]],
      ["row (active)", '[data-part="session-row"]', '[data-role="session-row"][data-active="true"]', ["@width", "@height", "gap", "backgroundColor", "borderTopLeftRadius"]],
      ["row (plain)", '[data-part="session-row"]:nth-of-type(2)', '[data-role="session-row"]:not([data-active])', ["@height", "backgroundColor"]],
      ["row pick", '[data-part="session-row"] > button:first-child', '[data-role="session-row"] > button:first-child', ["@height", "paddingLeft", "gap", "fontSize", "color"]],
      ["row sub", '[data-part="session-row"] > button:first-child > span > span:last-child', '[data-role="session-row"] > button:first-child > span > span:last-child', ["fontSize", "color"]],
      ["row check", '[data-part="session-row"] > button:first-child svg', '[data-role="session-row"][data-active] > button:first-child svg', ["@width", "@height", "color"]],
      ["pencil", '[data-part="session-row"] > button:last-child', '[data-role="edit-session"]', ["@width", "@height", "color", "borderTopLeftRadius", "marginRight"]],
      ["new session", ".rpprimary", '[data-role="session-new"]', [...BTN, "fontSize", "fontWeight", "borderTopColor"]],
      ["archived", ".rpbtn:not(.rpprimary)", '[data-role="open-archived"]', ["@width", "@height", "fontSize", "color", "backgroundColor", "borderTopColor"]],
    ],
  },
  {
    // The panel is as tall as the real provider list / form, so its @y and @height follow
    // the content (the smoke checks the alignment and the 8 px edge clamp); x and width are exact.
    id: "ctx-submenu-providers",
    pairs: [
      ["parent row (open)", '[data-part="ctx-parent"]', '[data-part="board-canvas-terminal"]', ["@x", "@y", "@width", "@height", "backgroundColor", "color", "borderTopLeftRadius", "fontSize"]],
      ["chevron", '[data-part="ctx-chevron"]', '[data-part="ctx-chevron"]', ["@width", "@height", "color"]],
      ["panel", '[data-part="ctx-submenu"]', '[data-part="ctx-submenu"]', ["@x", "@width", "backgroundColor", "borderTopColor", "borderTopWidth", "borderTopLeftRadius"]],
      ["panel title", '[data-part="ctx-submenu"] h2', '[data-part="ctx-submenu"] h2', [...TEXT, "@x"]],
      ["step label", '[data-part="ctx-submenu"] [data-part="steps"]', '[data-part="ctx-submenu"] header > div:last-child', ["fontSize", "color", "gap", "@height"]],
      ["legend", '[data-part="submenu-legend"]', '[data-part="submenu-legend"]', ["@height", "paddingLeft", "paddingTop", "gap", "fontSize", "color", "borderTopWidth", "borderTopColor"]],
      ["legend kbd", '[data-part="submenu-legend"] .rpk', '[data-part="submenu-legend"] span > span', ["@height", "fontSize", "color", "backgroundColor", "borderTopLeftRadius"]],
      ["provider tile", '[data-part="ctx-submenu"] .rpt', '[data-part="ctx-submenu"] [data-provider]', ["@x", "@height", "paddingLeft", "gap", "borderTopLeftRadius", "fontSize"]],
    ],
  },
  {
    id: "ctx-submenu-form",
    pairs: [
      ["panel", '[data-part="ctx-submenu"]', '[data-part="ctx-submenu"]', ["@x", "@width", "backgroundColor", "borderTopLeftRadius"]],
      ["folder field", '[data-part="ctx-submenu"] input', '[data-part="ctx-submenu"] input', ["@x", "@height", "paddingLeft", "borderTopLeftRadius", "backgroundColor", "fontFamily", "fontSize"]],
      ["create button", '[data-part="ctx-submenu"] .rpprimary', '[data-role="agent-flow-create"]', ["@height", "backgroundColor", "color", "fontWeight", "borderTopLeftRadius"]],
    ],
  },
  {
    id: "ctx-submenu-flip",
    pairs: [
      ["menu", '[role="menu"]', '[data-part="board-canvas-menu"]', ["@x", "@y", "@width"]],
      ["panel", '[data-part="ctx-submenu"]', '[data-part="ctx-submenu"]', ["@x", "@width"]],
    ],
  },
];

const spec = {
  props: [],
  frames: FRAMES.map((f) => ({
    id: f.id,
    pairs: f.pairs.map(([name, proto, app, props]) => ({ name, proto, app, props })),
  })),
};
const specPath = path.join(OUT, "parity-spec.json");
fs.writeFileSync(specPath, JSON.stringify(spec));

// ---------------------------------------------------------------- prototype side
const electronBin = path.join(process.cwd(), "node_modules/.bin/electron");
const protoRun = spawnSync(
  electronBin,
  ["--no-sandbox", path.join(process.cwd(), "scripts/verify/capture-rail-passos.cjs"), PROTO_DIR, OUT, specPath],
  { encoding: "utf8", timeout: 120000, env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: "x11" } },
);
if (protoRun.status !== 0) {
  console.error((protoRun.stderr || "").slice(-1500));
  throw new Error(`prototype capture exited ${protoRun.status}`);
}
const proto = JSON.parse(fs.readFileSync(path.join(OUT, "proto-measure.json"), "utf8"));

// ---------------------------------------------------------------- app side
async function setViewport(page, height) {
  await page.send("Emulation.setDeviceMetricsOverride", { width: W, height, deviceScaleFactor: 1, mobile: false });
  // Changing the zoom forces a full style recalc, so border widths snap to the new DPR.
  await page.evalJs(`document.body.style.zoom = "1.001"`);
  await delay(50);
  await page.evalJs(`document.body.style.zoom = "1"`);
  await delay(200);
}

const MEASURE = (pairs) => `(() => {
  const out = {};
  for (const pair of ${JSON.stringify(pairs)}) {
    const el = document.querySelector(pair.app);
    if (!el) { out[pair.name] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const row = {};
    for (const p of pair.props) {
      if (p === "@width") row[p] = r.width;
      else if (p === "@height") row[p] = r.height;
      else if (p === "@x") row[p] = r.x;
      else if (p === "@y") row[p] = r.y;
      else if (p === "@text") row[p] = el.innerText;
      else row[p] = cs[p];
    }
    out[pair.name] = row;
  }
  return out;
})()`;

const mouseMove = (page, x, y) => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
const center = (page, selector) =>
  page.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

const app = await startApp({ cdpPort: await pickFreePort(), userDataDir: USER_DATA_DIR, extraArgs: ["--force-device-scale-factor=1", "--ozone-platform=x11"], extraEnv: { GDK_SCALE: "1", GDK_DPI_SCALE: "1" } });
const measured = {};
const shots = {};
try {
  const cdpPort = app.cdpPort ?? app.port;
  const page = await connectPage(cdpPort);
  await delay(1000);
  await bootIntoFreshSession(page);
  await delay(600);
  await page.evalJs(`localStorage.setItem("ac.railHidden", "0")`);
  await setViewport(page, H);
  // Same facts as the mock: Demo project / Sprint board, autonomous, Agent A-C.
  await page.evalJs(`window.__stellarRail?.seedBoard(); window.__stellarRail?.setStep("closed")`);
  await delay(300);

  const states = {
    rail: async () => {
      await page.evalJs(`window.__stellarRail?.setStep("closed")`);
      const c = await center(page, '[data-role="rail-palette"]');
      await mouseMove(page, c.x, c.y);
    },
    "rail-panel": async () => {
      await mouseMove(page, 700, 300);
      await page.evalJs(`window.__stellarRail?.setStep("add")`);
    },
    "rail-hidden": async () => {
      await mouseMove(page, 700, 300);
      await page.evalJs(`window.__stellarRail?.hide()`);
    },
    "rail-reveal": async () => {
      await page.evalJs(`window.__stellarRail?.reveal()`);
    },
    "context-menu": async () => {
      await setViewport(page, H + 40);
      await page.evalJs(`localStorage.setItem("ac.railHidden", "0"); window.__stellarRail?.setStep("closed")`);
      await mouseMove(page, 700, 500);
      await page.evalJs(`window.__stellarOpenCanvasMenu?.(334, 52)`);
    },
    palette: async () => {
      await setViewport(page, H);
      await page.evalJs(`window.__stellarRail?.setStep("closed")`);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await mouseMove(page, 700, 500);
      const c = await center(page, '[data-role="rail-palette"]');
      await page.click(c.x, c.y);
    },
    "no-topbar-a": async () => {
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.evalJs(`window.__stellarRail?.setStep("closed")`);
      await mouseMove(page, 700, 500);
    },
    "titlebar-brand-win": async () => {
      await page.evalJs(`window.__stellarRail?.setStep("closed")`);
      await mouseMove(page, 700, 500);
    },
    "rail-sessions-list": async () => {
      await page.evalJs(`window.__stellarRail?.seedSessions()`);
      await mouseMove(page, 700, 500);
    },
    "ctx-submenu-providers": async () => {
      await setViewport(page, H);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await delay(150);
      await page.evalJs(`window.__stellarRail?.setStep("closed"); window.__stellarOpenCanvasMenu?.(334, 52)`);
      await delay(300);
      await page.evalJs(`document.querySelector('[data-part="board-canvas-terminal"]')?.click()`);
      await mouseMove(page, 5, 560);
    },
    "ctx-submenu-form": async () => {
      await setViewport(page, H);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await delay(150);
      await page.evalJs(`window.__stellarRail?.setStep("closed"); window.__stellarOpenCanvasMenu?.(334, 52)`);
      await delay(300);
      await page.evalJs(`document.querySelector('[data-part="board-canvas-terminal"]')?.click()`);
      await delay(300);
      await page.evalJs(`(document.querySelector('[data-part="ctx-submenu"] button:not(:disabled)[data-provider]'))?.click()`);
      await mouseMove(page, 5, 560);
    },
    "ctx-submenu-flip": async () => {
      await setViewport(page, H);
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await delay(150);
      await page.evalJs(`window.__stellarRail?.setStep("closed"); window.__stellarOpenCanvasMenu?.(590, 52)`);
      await delay(300);
      await page.evalJs(`document.querySelector('[data-part="board-canvas-terminal"]')?.click()`);
      await mouseMove(page, 5, 560);
    },
    "no-topbar-b": async () => {
      await page.evalJs(`window.__stellarRail?.seedBoard()`);
      await mouseMove(page, 700, 500);
    },
  };

  for (const frame of spec.frames) {
    await states[frame.id]();
    await delay(450);
    measured[frame.id] = await page.evalJs(MEASURE(frame.pairs));
    const { data } = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    shots[frame.id] = path.join(OUT, `app-parity-${frame.id}.png`);
    fs.writeFileSync(shots[frame.id], Buffer.from(data, "base64"));
  }
} finally {
  await stopApp(app);
}

// ---------------------------------------------------------------- compare
const norm = (v, prop) => {
  if (v === null || v === undefined) return "—";
  // A font stack is the same face when its first family is.
  if (prop === "fontFamily") return String(v).split(",")[0].replace(/"/g, "").trim();
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return String(v)
    .replace(/(\d+\.\d{3,})px/g, (_, n) => `${Math.round(parseFloat(n) * 100) / 100}px`)
    .replace(/\s+/g, " ");
};
const { check, finish } = makeChecker();
const rows = [];
let diffs = 0;
for (const frame of spec.frames) {
  for (const pair of frame.pairs) {
    const p = proto[frame.id]?.[pair.name];
    const a = measured[frame.id]?.[pair.name];
    if (!p || !a) {
      rows.push(`| ${frame.id} | ${pair.name} | — | ${p ? "proto ok" : "proto MISSING"} | ${a ? "app ok" : "app MISSING"} | ✗ |`);
      diffs++;
      check(`${frame.id} · ${pair.name} exists on both sides`, false, true);
      continue;
    }
    const bad = [];
    for (const prop of pair.props) {
      const pv = norm(p[prop], prop);
      const av = norm(a[prop], prop);
      const same = pv === av;
      rows.push(`| ${frame.id} | ${pair.name} | ${prop} | ${pv} | ${av} | ${same ? "✓" : "✗"} |`);
      if (!same) bad.push(`${prop}: proto ${pv} ≠ app ${av}`);
    }
    if (bad.length) diffs += bad.length;
    check(`${frame.id} · ${pair.name} (${pair.props.length} props)`, bad.join("; ") || "equal", (v) => v === "equal");
  }
}
const table = `# Rail parity — RailPassos.dc.html × app (getComputedStyle)\n\n| frame | element | property | prototype | app | |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n\nDivergent values: ${diffs}\n`;
fs.writeFileSync(path.join(OUT, "parity-table.md"), table);
fs.writeFileSync(path.join(OUT, "parity.json"), JSON.stringify({ proto, app: measured, diffs }, null, 2));

// side-by-side images
for (const frame of spec.frames) {
  const py = `
from PIL import Image, ImageDraw
a = Image.open(${JSON.stringify(path.join(OUT, `proto-${frame.id}.png`))}).convert("RGB")
b = Image.open(${JSON.stringify(shots[frame.id])}).convert("RGB")
gap, lh = 16, 24
c = Image.new("RGB", (a.width + b.width + gap, max(a.height, b.height) + lh), (12, 14, 18))
d = ImageDraw.Draw(c)
d.text((8, 6), "prototype · ${frame.id}", fill=(180, 190, 210))
d.text((a.width + gap + 8, 6), "app · ${frame.id}", fill=(180, 190, 210))
c.paste(a, (0, lh)); c.paste(b, (a.width + gap, lh))
c.save(${JSON.stringify(path.join(OUT, `side-by-side-${frame.id}.png`))})
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) console.error(r.stderr);
}
console.log(`\nparity table: ${path.join(OUT, "parity-table.md")} — divergent values: ${diffs}`);
finish();
