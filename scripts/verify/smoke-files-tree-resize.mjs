/**
 * The code-card tree divider is a 0-width handle whose hit target and foam
 * highlight live on ::after. A pointer drag must still change the tree width.
 * Isolated app: own userData and CDP port. Never the owner's instance.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, pickFreePort, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-tree-resize-"));
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "stellar-tree-resize-git-"));
const { check, finish } = makeChecker();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(join(SCRATCH_DIR, "src"), { recursive: true });
writeFileSync(join(SCRATCH_DIR, "src", "note.ts"), "export const note = 1;\n");
execFileSync("git", ["init", "-b", "main"], { cwd: SCRATCH_DIR, stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.name", "smoke"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.email", "smoke@example.invalid"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "add", "-A"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "commit", "-m", "seed"], { stdio: "ignore" });

let app;
try {
  app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
  const page = await connectPage(CDP_PORT);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await bootIntoFreshSession(page, "Tree resize", { spawnTerminal: false });
  await wait(400);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((boards) => {
    const board = boards.find((item) => item.name === "Tree resize") ?? boards[0];
    if (!board) throw new Error("no board");
    return JSON.stringify(board.id);
  })`));
  await page.evalJs(`(async () => {
    if (typeof window.store.boards.update === "function") {
      const boards = await window.store.boards.list();
      const board = boards.find((item) => item.id === ${JSON.stringify(boardId)});
      if (board) await window.store.boards.update({ ...board, cwd: ${JSON.stringify(SCRATCH_DIR)} });
    }
    await window.store.upsert({
      id: "tree-resize",
      board_id: ${JSON.stringify(boardId)},
      kind: "files",
      provider: "",
      cwd: ${JSON.stringify(SCRATCH_DIR)},
      x: 40, y: 48, w: 900, h: 560,
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
      .find((el) => el.textContent.trim().includes("Tree resize"))?.click()
  `);
  let handle = null;
  for (let i = 0; i < 50; i++) {
    handle = JSON.parse(await page.evalJs(`(() => {
      const el = document.querySelector(".files-card .files-tree-resize");
      if (!el) return "null";
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
    })()`));
    if (handle && handle.h > 20) break;
    handle = null;
    await wait(100);
  }
  check("resize handle is on screen", handle != null && handle.h > 20, true);
  if (!handle) throw new Error("files tree resize handle did not mount");

  const asideWidth = () => page.evalJs(`document.querySelector(".files-card aside")?.getBoundingClientRect().width || 0`);
  const before = Number(await asideWidth());
  check("tree starts at the default width", before > 200 && before < 320, true);

  const hitX = handle.x - 1;
  const hitY = handle.y + handle.h / 2;
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: hitX,
    y: hitY,
    pointerType: "mouse",
  });
  await wait(50);
  const hoverBg = String(await page.evalJs(
    `getComputedStyle(document.querySelector(".files-card .files-tree-resize"), "::after").backgroundColor`,
  ));
  check("hover paints the foam line on ::after", hoverBg === "rgb(69, 200, 255)", true);

  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: hitX,
    y: hitY,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
  await wait(50);
  const dragging = await page.evalJs(
    `document.querySelector(".files-card .files-tree-resize")?.classList.contains("is-dragging") === true`,
  );
  check("drag keeps the highlight class", dragging, true);
  const dragBg = String(await page.evalJs(
    `getComputedStyle(document.querySelector(".files-card .files-tree-resize"), "::after").backgroundColor`,
  ));
  check("drag paints the foam line on ::after", dragBg === "rgb(69, 200, 255)", true);

  const dragX = hitX + 48;
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: dragX,
    y: hitY,
    button: "left",
    buttons: 1,
    pointerType: "mouse",
  });
  await wait(80);
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: dragX,
    y: hitY,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
  await wait(80);
  const after = Number(await asideWidth());
  check("drag changes the tree width", after > before + 20, true);
  console.log(`tree width ${before} -> ${after}`);
} finally {
  if (app) await stopApp(app);
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

finish();
