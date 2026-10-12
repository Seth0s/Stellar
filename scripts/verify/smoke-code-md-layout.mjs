/**
 * A markdown file open in reading mode keeps the editor layout: the
 * reading/code toggle sits in the tab bar next to "Dividir", and the
 * rendered text and the minimap share one row that fills the column.
 * Isolated app: own userData and CDP port.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, pickFreePort, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = process.env.CODE_CARD_SHOTS ?? join(PROJECT_ROOT, ".verify-tmp/code-md-layout");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-code-md-"));
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "stellar-code-md-git-"));
const { check, finish } = makeChecker();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SCRATCH_DIR, { recursive: true });
writeFileSync(
  join(SCRATCH_DIR, "notes.md"),
  "# Title\n\n" +
    Array.from({ length: 60 }, (_, i) => `## Section ${i}\n\nParagraph ${i} with **bold** text and a list:\n\n1. one\n2. two\n`).join("\n"),
);
writeFileSync(
  join(SCRATCH_DIR, "sample.ts"),
  Array.from({ length: 40 }, (_, i) => `export function step${i}(input: number) {\n  return input + ${i};\n}\n`).join("\n"),
);
execFileSync("git", ["init", "-b", "main"], { cwd: SCRATCH_DIR, stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.name", "smoke"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.email", "smoke@example.invalid"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "add", "-A"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "commit", "-m", "seed"], { stdio: "ignore" });

const MEASURE = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
  };
  const main = document.querySelector(".files-editor");
  const pane = document.querySelector(".files-editor-preview, .cm-editor")?.closest("[class*='editorPane']");
  const row = pane?.parentElement ?? null;
  const toggle = [...document.querySelectorAll(".files-card [class*='tabActions'] button")].map((b) => b.textContent.trim());
  return JSON.stringify({
    main: rect(main),
    row: rect(row),
    pane: rect(pane),
    minimap: rect(row?.querySelector("[class*='minimap']")),
    preview: rect(document.querySelector(".files-editor-preview")),
    cm: rect(document.querySelector(".cm-editor")),
    tabs: rect(document.querySelector("[class*='tabActions']")?.parentElement),
    crumbs: rect(document.querySelector("[class*='crumbs']")),
    actions: toggle,
    crumbButtons: document.querySelectorAll("[class*='crumbs'] button").length,
  });
})()`;

async function shot(page, name) {
  const clip = JSON.parse(await page.evalJs(`(() => {
    const r = document.querySelector(".files-card")?.getBoundingClientRect();
    if (!r) return "null";
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 });
  })()`));
  const png = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip });
  const path = join(OUT_DIR, name);
  writeFileSync(path, Buffer.from(png.data, "base64"));
  return path;
}

async function clickNode(page, name) {
  for (let i = 0; i < 40; i++) {
    const found = await page.evalJs(`(() => {
      const hit = [...document.querySelectorAll(".files-card .files-node-name")].find((el) => el.textContent === ${JSON.stringify(name)});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    if (found) return;
    await wait(100);
  }
  throw new Error(`tree node not found: ${name}`);
}

let app;
try {
  app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
  const page = await connectPage(CDP_PORT);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await bootIntoFreshSession(page, "Code md layout", { spawnTerminal: false });
  await wait(400);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((boards) => {
    const board = boards.find((item) => item.name === "Code md layout") ?? boards[0];
    if (!board) throw new Error("no board");
    return JSON.stringify(board.id);
  })`));
  await page.evalJs(`(async () => {
    await window.store.upsert({
      id: "code-md-layout",
      board_id: ${JSON.stringify(boardId)},
      kind: "files",
      provider: "",
      cwd: ${JSON.stringify(SCRATCH_DIR)},
      x: 24, y: 16, w: 1100, h: 760,
      resume_id: null, model: null, effort: null, system_prompt: null,
      group_id: null, label: "Stellar",
      updated_at: Date.now(),
    });
    return true;
  })()`);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await wait(100);
  }
  await page.evalJs(`
    [...document.querySelectorAll(".home-session-name")]
      .find((el) => el.textContent.trim().includes("Code md layout"))?.click()
  `);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card .files-node-name")`)) break;
    await wait(100);
  }

  await clickNode(page, "notes.md");
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card .files-editor-preview, .files-card .cm-scroller")`)) break;
    await wait(100);
  }
  await wait(400);
  let reading = JSON.parse(await page.evalJs(MEASURE));
  if (!reading.preview) {
    // The file opens in code mode: flip to reading through the tab-bar toggle.
    await page.evalJs(`[...document.querySelectorAll(".files-card [class*='tabActions'] button")].find((b) => /leitura|reading|preview|pré/i.test(b.textContent))?.click()`);
    await wait(500);
    reading = JSON.parse(await page.evalJs(MEASURE));
  }
  console.log("READING", JSON.stringify(reading));
  const readingShot = await shot(page, "md-reading.png");

  await page.evalJs(`[...document.querySelectorAll(".files-card [class*='tabActions'] button")][0]?.click()`);
  await wait(500);
  const code = JSON.parse(await page.evalJs(MEASURE));
  console.log("CODE", JSON.stringify(code));
  const codeShot = await shot(page, "md-code.png");
  await clickNode(page, "sample.ts");
  await wait(600);
  const tsShot = await shot(page, "ts-code.png");
  console.log("SHOTS", readingShot, codeShot, tsShot);

  const near = (a, b, tol = 2) => a != null && b != null && Math.abs(a - b) <= tol;
  for (const [label, m, body] of [["reading", reading, reading.preview], ["code", code, code.cm]]) {
    check(`${label}: toggle lives in the tab bar`, m.actions.length === 2 && m.actions.includes("Dividir") && !m.actions.some((a) => /Diff/.test(a)), true);
    check(`${label}: no button left in the breadcrumb row`, m.crumbButtons, 0);
    check(`${label}: minimap sits beside the content`, m.minimap != null && body != null && m.minimap.left >= body.right - 1 && near(m.minimap.top, body.top), true);
    check(`${label}: content fills the row height`, body != null && m.row != null && near(body.height, m.row.height, 3), true);
    check(`${label}: minimap fills the row height`, m.minimap != null && m.row != null && near(m.minimap.height, m.row.height, 3), true);
  }
} finally {
  if (app) await stopApp(app);
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

finish();
