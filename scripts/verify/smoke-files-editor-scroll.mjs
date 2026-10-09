/**
 * A large file must scroll inside the code column. The problems panel and
 * the card footer keep their rect when that file opens, and both stay inside
 * the card after the card is made shorter.
 * Isolated app: own userData and CDP port.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, pickFreePort, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = join(PROJECT_ROOT, ".verify-tmp/files-editor-scroll");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-editor-scroll-"));
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "stellar-editor-scroll-git-"));
const { check, finish } = makeChecker();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SCRATCH_DIR, { recursive: true });
writeFileSync(join(SCRATCH_DIR, "small.ts"), Array.from({ length: 12 }, (_, i) => `export const small${i} = ${i};`).join("\n") + "\n");
writeFileSync(
  join(SCRATCH_DIR, "big.ts"),
  `export const wide = "${"x".repeat(400)}";\n` +
    Array.from({ length: 2200 }, (_, i) => `export const line${String(i).padStart(4, "0")} = ${i};`).join("\n") +
    "\n",
);
execFileSync("git", ["init", "-b", "main"], { cwd: SCRATCH_DIR, stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.name", "smoke"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.email", "smoke@example.invalid"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "add", "-A"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "commit", "-m", "seed"], { stdio: "ignore" });

const MEASURE = `(() => {
  const card = document.querySelector(".files-card");
  const main = document.querySelector(".files-editor");
  const scroller = document.querySelector(".cm-scroller");
  const pick = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      client: el.clientHeight,
      scroll: el.scrollHeight,
      overflow: s.overflowY,
      minH: s.minHeight,
    };
  };
  const bottom = main?.lastElementChild ?? null;
  const foot = document.querySelector(".files-card .card-foot");
  return JSON.stringify({
    card: pick(card),
    ide: pick(card?.querySelector(":scope > .card-scale .card-clip > div:nth-child(2)")),
    main: pick(main),
    editorRow: pick(bottom?.previousElementSibling ?? null),
    pane: pick(document.querySelector(".code-editor")?.parentElement ?? null),
    editor: pick(document.querySelector(".code-editor")),
    cm: pick(document.querySelector(".cm-editor")),
    scroller: pick(scroller),
    bottom: pick(bottom),
    foot: pick(foot),
    scrollTop: scroller ? scroller.scrollTop : null,
  });
})()`;

function near(a, b, tol = 2) {
  return a != null && b != null && Math.abs(a - b) <= tol;
}

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

async function waitScroller(page) {
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card .cm-scroller")`)) return;
    await wait(100);
  }
  throw new Error("code editor did not mount");
}

let app;
const shots = {};
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
  await bootIntoFreshSession(page, "Editor scroll", { spawnTerminal: false });
  await wait(400);

  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((boards) => {
    const board = boards.find((item) => item.name === "Editor scroll") ?? boards[0];
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
      id: "editor-scroll",
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
      .find((el) => el.textContent.trim().includes("Editor scroll"))?.click()
  `);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card .files-node-name")`)) break;
    await wait(100);
  }

  await clickNode(page, "small.ts");
  await waitScroller(page);
  await wait(200);
  const before = JSON.parse(await page.evalJs(MEASURE));
  console.log("CHAIN small", JSON.stringify(before));
  console.log("shot before");
  shots.before = await shot(page, "before-large.png");
  console.log("shot before done");

  await clickNode(page, "big.ts");
  let after = null;
  for (let i = 0; i < 50; i++) {
    after = JSON.parse(await page.evalJs(MEASURE));
    if ((after.scroller?.scroll ?? 0) > 2000) break;
    await wait(100);
  }
  console.log("CHAIN large", JSON.stringify(after));

  const hit = JSON.parse(await page.evalJs(`(() => {
    const r = document.querySelector(".cm-scroller")?.getBoundingClientRect();
    if (!r) return "null";
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + Math.min(40, r.height / 2) });
  })()`));
  const scrollBeforeWheel = Number(await page.evalJs(`document.querySelector(".cm-scroller")?.scrollTop || 0`));
  console.log("wheel at", JSON.stringify(hit), "from", scrollBeforeWheel);
  if (hit) {
    for (let i = 0; i < 4; i++) {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: hit.x,
        y: hit.y,
        deltaX: 0,
        deltaY: 240,
        pointerType: "mouse",
      });
      await wait(40);
    }
  }
  await wait(80);
  const scrollAfterWheel = Number(await page.evalJs(`document.querySelector(".cm-scroller")?.scrollTop || 0`));
  console.log("WHEEL", scrollBeforeWheel, "->", scrollAfterWheel);
  shots.after = await shot(page, "after-large.png");

  const edge = JSON.parse(await page.evalJs(`(() => {
    const r = document.querySelector(".files-card")?.getBoundingClientRect();
    if (!r) return "null";
    return JSON.stringify({ x: r.x + r.width / 2, y: r.bottom - 2 });
  })()`));
  const heightBefore = before.card?.height ?? 0;
  if (edge) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: edge.x,
      y: edge.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: edge.x,
      y: edge.y - 180,
      button: "left",
      buttons: 1,
      pointerType: "mouse",
    });
    await wait(60);
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: edge.x,
      y: edge.y - 180,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });
  }
  await wait(200);
  const shorter = JSON.parse(await page.evalJs(MEASURE));
  console.log("CHAIN short", JSON.stringify(shorter));
  shots.short = await shot(page, "after-shorter.png");

  const inside = (box, card) => box && card && box.top >= card.top - 2 && box.bottom <= card.bottom + 2;
  const wide = JSON.parse(await page.evalJs(`(() => {
    const el = document.querySelector(".cm-scroller");
    if (!el) return "null";
    return JSON.stringify({ client: el.clientWidth, scroll: el.scrollWidth });
  })()`));
  check("scroller is taller than its viewport", (after.scroller?.scroll ?? 0) > (after.scroller?.client ?? 0) && (after.scroller?.client ?? 0) < 2000, true);
  check("scroller is wider than its viewport", wide && wide.scroll > wide.client + 20, true);
  check("wheel moves scrollTop", scrollAfterWheel > scrollBeforeWheel + 10, true);
  check("problems panel rect holds after the large file", near(before.bottom?.top, after.bottom?.top) && near(before.bottom?.height, after.bottom?.height), true);
  check("footer rect holds after the large file", near(before.foot?.top, after.foot?.top) && near(before.foot?.height, after.foot?.height), true);
  check("problems panel stays inside the card", inside(after.bottom, after.card), true);
  check("footer stays inside the card", inside(after.foot, after.card), true);
  check("shorter card is actually shorter", (shorter.card?.height ?? 9999) < heightBefore - 40, true);
  check("problems panel stays inside the shorter card", inside(shorter.bottom, shorter.card), true);
  check("footer stays inside the shorter card", inside(shorter.foot, shorter.card), true);
  check("scroller still overflows after the resize", (shorter.scroller?.scroll ?? 0) > (shorter.scroller?.client ?? 0), true);
  console.log("SHOTS", JSON.stringify(shots));
} finally {
  if (app) await stopApp(app);
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

finish();
