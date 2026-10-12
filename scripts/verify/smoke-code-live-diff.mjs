/**
 * Live diff: an external write to the open file is marked inline with no
 * button (tinted rows, signs, ghost rows for removed lines), keeps the
 * scroll position, folds a long removal, accepts and undoes, and marks the
 * markdown reading view per block. Also the status bar and bottom tabs
 * alignment. Isolated app: own userData and CDP port.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, pickFreePort, bootIntoFreshSession, makeChecker } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT_DIR = process.env.CODE_CARD_SHOTS ?? join(PROJECT_ROOT, ".verify-tmp/code-live-diff");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-code-live-"));
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "stellar-code-live-git-"));
const { check, finish } = makeChecker();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SCRATCH_DIR, { recursive: true });
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const BASE_TS = lines(120, (i) => `export const row${String(i).padStart(3, "0")} = ${i};`).join("\n") + "\n";
const BASE_MD = ["# Title", "", "First paragraph stays.", "", "Old paragraph text.", "", "- item one", "- item two", "", "Last paragraph stays."].join("\n") + "\n";
writeFileSync(join(SCRATCH_DIR, "worker.ts"), BASE_TS);
writeFileSync(join(SCRATCH_DIR, "guide.md"), BASE_MD);
execFileSync("git", ["init", "-b", "main"], { cwd: SCRATCH_DIR, stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.name", "smoke"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.email", "smoke@example.invalid"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "add", "-A"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "commit", "-m", "seed"], { stdio: "ignore" });

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const sc = q(".cm-scroller");
  const foot = q(".files-card-foot-row");
  const footSpans = foot ? [...foot.children].map((e) => ({ text: e.textContent.trim(), left: Math.round(e.getBoundingClientRect().left), right: Math.round(e.getBoundingClientRect().right) })) : [];
  return JSON.stringify({
    added: qa(".cm-live-add").length,
    fresh: qa(".cm-live-fresh").length,
    ghosts: qa(".cm-live-ghost").length,
    ghostRows: qa(".cm-live-ghost-row").length,
    folds: qa(".cm-live-ghost-fold").map((b) => b.textContent.trim()),
    signs: qa(".cm-live-sign-gutter .cm-live-sign").map((e) => e.textContent).filter(Boolean).join(""),
    words: qa(".cm-live-word").map((e) => e.textContent),
    scrollTop: sc ? Math.round(sc.scrollTop) : null,
    topLine: sc ? ([...document.querySelectorAll(".cm-line")].find((l) => l.getBoundingClientRect().bottom > sc.getBoundingClientRect().top + 2)?.textContent ?? null) : null,
    summary: (q("[class*='crumbs']")?.textContent ?? "").trim(),
    tabButtons: qa(".files-card [class*='tabActions'] button").map((b) => b.textContent.trim()),
    toast: q("[class*='liveToast']")?.textContent.trim() ?? null,
    pill: q("[class*='livePill']")?.textContent.trim() ?? null,
    mdAdd: qa("[data-md-diff='add']").length,
    mdDel: qa("[class*='md-diff-del']").length,
    mdFold: qa(".md-diff-fold").length,
    foot: footSpans,
    footRect: rect(foot),
    bottomTabs: qa("[class*='bottomTabs'] button").map((b) => ({ text: b.textContent.trim(), right: Math.round(b.getBoundingClientRect().right) })),
    bottomRight: rect(q("[class*='bottomTabs']"))?.right ?? null,
    minimapBeside: (() => { const m = q("[class*='minimap']"); const p = q("[class*='editorPane']"); return !!m && !!p && m.getBoundingClientRect().left >= p.getBoundingClientRect().right - 1; })(),
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

async function until(page, label, test, ms = 8000) {
  const t0 = Date.now();
  let m = null;
  while (Date.now() - t0 < ms) {
    m = JSON.parse(await page.evalJs(MEASURE));
    if (test(m)) return m;
    await wait(120);
  }
  console.log("TIMEOUT waiting for", label, JSON.stringify(m));
  return m;
}

const clickText = (page, selector, rx) =>
  page.evalJs(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${rx}.test(e.textContent)); if (!b) return false; b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); b.click(); return true; })()`);

let app;
try {
  app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
  const page = await connectPage(CDP_PORT);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await bootIntoFreshSession(page, "Code live diff", { spawnTerminal: false });
  await wait(400);
  const boardId = JSON.parse(await page.evalJs(`window.store.boards.list().then((boards) => {
    const board = boards.find((item) => item.name === "Code live diff") ?? boards[0];
    return JSON.stringify(board.id);
  })`));
  await page.evalJs(`(async () => {
    await window.store.upsert({
      id: "code-live-diff", board_id: ${JSON.stringify(boardId)}, kind: "files", provider: "",
      cwd: ${JSON.stringify(SCRATCH_DIR)}, x: 24, y: 16, w: 1100, h: 760,
      resume_id: null, model: null, effort: null, system_prompt: null,
      group_id: null, label: "Stellar", updated_at: Date.now(),
    });
    return true;
  })()`);
  await page.evalJs(`document.querySelector(".topbar-home")?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".home-session-card")`)) break;
    await wait(100);
  }
  await page.evalJs(`[...document.querySelectorAll(".home-session-name")].find((el) => el.textContent.trim().includes("Code live diff"))?.click()`);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card .files-node-name")`)) break;
    await wait(100);
  }

  // ---- code: no change yet
  await clickNode(page, "worker.ts");
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card .cm-scroller")`)) break;
    await wait(100);
  }
  await wait(500);
  const idle = JSON.parse(await page.evalJs(MEASURE));
  const idleShot = await shot(page, "01-sem-mudancas.png");

  // scroll a bit so we can prove the scroll survives the write
  await page.evalJs(`(() => { const sc = document.querySelector(".cm-scroller"); sc.scrollTop = 600; sc.dispatchEvent(new Event("scroll")); })()`);
  await wait(900);
  const before = JSON.parse(await page.evalJs(MEASURE));
  const scrollBefore = before.scrollTop;

  // ---- an external write: one changed row, a 2-row insertion, a 6-row removal
  const next = BASE_TS.split("\n");
  next[10] = "export const row010 = 1010;";
  next.splice(12, 0, "export const inserted1 = 1;", "export const inserted2 = 2;");
  next.splice(40, 6);
  writeFileSync(join(SCRATCH_DIR, "worker.ts"), next.join("\n"));
  const edited = await until(page, "marks", (m) => m.added >= 3 && m.ghosts >= 2 && m.fresh >= 1);
  await wait(500);
  const settled = JSON.parse(await page.evalJs(MEASURE));
  const editedShot = await shot(page, "02-editando.png");

  // ---- fold toggle
  const foldBefore = edited.folds.slice();
  await clickText(page, ".cm-live-ghost-fold", "/removed|removidas/");
  const opened = await until(page, "unfold", (m) => m.ghostRows >= 7);
  const openedShot = await shot(page, "03-remocao-aberta.png");
  await clickText(page, ".cm-live-ghost-fold", "/removed|removidas/");
  await until(page, "refold", (m) => m.folds.length >= 1 && m.ghostRows <= 2);

  // ---- hover tooltip: accept just one hunk, then bring it back with undo
  await page.evalJs(`document.querySelector(".cm-scroller").scrollTop = 0`);
  await wait(300);
  const target = JSON.parse(await page.evalJs(`(() => {
    const el = document.querySelector(".cm-live-add");
    if (!el) return "null";
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left + 120, y: r.top + r.height / 2 });
  })()`));
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, pointerType: "mouse" });
  let tip = null;
  for (let i = 0; i < 30 && !tip; i++) {
    await wait(100);
    tip = await page.evalJs(`document.querySelector(".cm-agent-tooltip")?.textContent ?? null`);
  }
  const tipShot = await shot(page, "07-tooltip.png");
  await clickText(page, ".cm-agent-tooltip button", "/Aceitar este trecho|Accept this change/");
  const afterHunk = await until(page, "hunk accepted", (m) => m.added < 3);
  await clickText(page, "[class*='liveToast'] button", "/Desfazer|Undo/");
  await until(page, "hunk undone", (m) => m.added >= 3);

  // ---- Alt+ArrowDown jumps to the next change
  await page.evalJs(`document.querySelector(".cm-content")?.focus()`);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 1 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 1 });
  await wait(500);
  const lnAfterNav = await page.evalJs(`document.querySelector(".files-card-foot-row")?.textContent ?? ""`);

  // ---- accept all, then undo
  await clickText(page, "[class*='crumbs'] button", "/Aceitar tudo|Accept all/");
  const accepted = await until(page, "accepted", (m) => m.added === 0 && m.ghosts === 0);
  const acceptedShot = await shot(page, "04-aceito.png");
  await clickText(page, "[class*='liveToast'] button", "/Desfazer|Undo/");
  const undone = await until(page, "undone", (m) => m.added >= 3);

  // ---- a write below the viewport raises the hint
  await page.evalJs(`document.querySelector(".cm-scroller").scrollTop = 0`);
  await wait(300);
  const again = next.slice();
  again[110] = "export const row110 = 9999;";
  writeFileSync(join(SCRATCH_DIR, "worker.ts"), again.join("\n"));
  const pill = await until(page, "pill", (m) => !!m.pill);
  const pillShot = await shot(page, "05-fora-da-tela.png");

  // ---- markdown reading view
  await clickNode(page, "guide.md");
  await until(page, "md", () => true, 600);
  await wait(500);
  const mdNext = BASE_MD.replace("Old paragraph text.", "New paragraph text.").replace("- item two", "- item two\n- item three");
  writeFileSync(join(SCRATCH_DIR, "guide.md"), mdNext);
  const md = await until(page, "md marks", (m) => m.mdAdd >= 1);
  if (md.mdAdd < 1) console.log("MD-DOM", await page.evalJs(`(document.querySelector(".files-card [class*='editorPane']")?.innerHTML ?? "").slice(0, 1500)`));
  const mdShot = await shot(page, "06-leitura-md.png");
  const statusShot = mdShot;

  console.log("TIP", JSON.stringify(tip), "AFTER-HUNK", afterHunk.added, "NAV", lnAfterNav);
  console.log("SCROLL", scrollBefore, "->", edited.scrollTop, JSON.stringify(before.topLine), "->", JSON.stringify(settled.topLine), "settled", settled.scrollTop);
  // ---- your own typing is marked too, with no agent strip
  await clickNode(page, "worker.ts");
  await wait(600);
  await page.evalJs(`document.querySelector(".cm-content")?.focus()`);
  await page.send("Input.insertText", { text: "zz" });
  const typed = await until(page, "typed", (m) => m.added >= 1 && m.fresh === 0, 4000);
  console.log("IDLE", JSON.stringify(idle));
  console.log("EDITED", JSON.stringify(edited));
  console.log("OPENED", JSON.stringify(opened));
  console.log("ACCEPTED", JSON.stringify(accepted));
  console.log("UNDONE", JSON.stringify(undone));
  console.log("PILL", JSON.stringify(pill));
  console.log("MD", JSON.stringify(md));
  console.log("SHOTS", [idleShot, editedShot, openedShot, acceptedShot, pillShot, statusShot].join(" "));

  check("no 'Diff com HEAD' button", edited.tabButtons.every((b) => !/Diff com HEAD|Fechar diff/.test(b)), true);
  check("idle: no marks and a 'live' line", idle.added === 0 && idle.ghosts === 0 && /ao vivo|live/.test(idle.summary), true);
  check("write marks the changed and inserted rows", edited.added >= 3, true);
  check("write shows ghost rows for removed lines", edited.ghosts >= 2, true);
  check("a 6-row removal starts folded", foldBefore.some((f) => /6/.test(f)), true);
  check("signs show + and −", edited.signs.includes("+") && edited.signs.includes("−"), true);
  check("changed word is highlighted", edited.words.length >= 1, true);
  check("new rows pulse once", edited.fresh >= 1, true);
  check("the same line stays at the top of the view after the write", before.topLine != null && before.topLine === settled.topLine && (scrollBefore ?? 0) > 100, true);
  check("summary counts the change", /\+\d+/.test(edited.summary) && /−\d+/.test(edited.summary), true);
  check("hover tooltip offers 'accept this change' without an agent claim", /Aceitar|Accept/.test(tip ?? "") && /Alterado|Changed/.test(tip ?? ""), true);
  check("accepting one hunk clears only that hunk", afterHunk.added < 3 && afterHunk.added >= 1, true);
  check("Alt+ArrowDown moves the cursor to a change, without moving a line", /Ln (?!1,)\d+/.test(lnAfterNav) && /salvo/.test(lnAfterNav) && !/não salvo/.test(lnAfterNav), true);
  check("open removal lists its rows", opened.ghostRows >= 7, true);
  check("accept clears every mark and offers undo", accepted.added === 0 && accepted.ghosts === 0 && /Marcas limpas|Marks cleared/.test(accepted.toast ?? ""), true);
  check("undo brings the marks back", undone.added >= 3, true);
  check("a change below the viewport raises the hint", /abaixo|below/.test(pill.pill ?? ""), true);
  check("markdown reading marks added blocks", md.mdAdd >= 1, true);
  check("markdown reading folds the removed block", md.mdFold >= 1, true);
  check("your own typing is marked as a change, not as a fresh agent write", typed.added >= 1 && typed.fresh === 0, true);
  check("minimap stays beside the content", md.minimapBeside, true);
  const lastFoot = md.foot[md.foot.length - 1];
  const lnCol = md.foot.find((f) => /Ln \d+|Lin/.test(f.text));
  check("status: 'salvo' is at the right edge", lastFoot != null && md.footRect != null && md.footRect.right - lastFoot.right <= 20, true);
  check("status: Ln/Col sits in the right group", lnCol != null && md.footRect != null && lnCol.left > (md.footRect.left + md.footRect.right) / 2, true);
  const gaps = md.foot.slice(1).map((f, i) => f.left - md.foot[i].right);
  check("status: 16px gap between items", gaps.length > 0 && gaps.every((g) => Math.abs(g - 16) <= 1 || g > 16), true);
  check("status: language spelled out", md.foot.some((f) => f.text === "Markdown"), true);
  const send = md.bottomTabs[md.bottomTabs.length - 1];
  check("bottom tabs: last tab is right-aligned", send != null && md.bottomRight != null && md.bottomRight - send.right <= 20, true);
} finally {
  if (app) await stopApp(app);
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

finish();
