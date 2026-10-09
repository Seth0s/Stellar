/**
 * Measure FilesCard / CodeEditor cost for large files BEFORE/AFTER the
 * IDE performance fix. Isolated app (own userData + CDP port). Never
 * attaches to the owner's live session.
 *
 * Fixtures: 1k / 10k / 50k / 200k lines × (.md, .ts).
 * For each: time to first content paint, long tasks on open, long tasks
 * during 5s board drag, renderer heap, cost probes (minimap split,
 * breadcrumb, token estimate, markdown preview presence, tooLarge).
 *
 * Usage: node scripts/verify/smoke-files-editor-large-perf.mjs [label]
 * Writes JSON to .verify-tmp/files-editor-large-perf/<label>.json
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, stopApp, connectPage, pickFreePort, bootIntoFreshSession } from "./cdp-client.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LABEL = process.argv[2] || "baseline";
const OUT_DIR = join(PROJECT_ROOT, ".verify-tmp/files-editor-large-perf");
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-editor-perf-"));
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "stellar-editor-perf-git-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = [1000, 10_000, 50_000, 200_000];
const EXTS = ["md", "ts"];

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SCRATCH_DIR, { recursive: true });

function makeBody(lines, ext) {
  // Exactly `lines` newline-terminated rows so byte size tracks line count.
  if (ext === "md") {
    const rows = [`# Perf fixture ${lines}`];
    for (let i = 1; i < lines; i++) {
      rows.push(`- item ${i} with enough text for a realistic markdown line`);
    }
    return rows.join("\n") + "\n";
  }
  const rows = [`export const seed = 0;`];
  for (let i = 1; i < lines; i++) {
    rows.push(`export const line${String(i).padStart(6, "0")} = ${i};`);
  }
  return rows.join("\n") + "\n";
}

const files = [];
for (const n of SIZES) {
  for (const ext of EXTS) {
    const name = `f${n}.${ext}`;
    const body = makeBody(n, ext);
    writeFileSync(join(SCRATCH_DIR, name), body);
    files.push({ name, lines: n, ext, bytes: Buffer.byteLength(body) });
  }
}
execFileSync("git", ["init", "-b", "main"], { cwd: SCRATCH_DIR, stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.name", "smoke"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "config", "user.email", "smoke@example.invalid"], { stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "add", "-A"], { cwd: SCRATCH_DIR, stdio: "ignore" });
execFileSync("git", ["-C", SCRATCH_DIR, "commit", "-m", "seed"], { cwd: SCRATCH_DIR, stdio: "ignore" });

async function clickNode(page, name) {
  for (let i = 0; i < 60; i++) {
    const found = await page.evalJs(`(() => {
      const card = document.querySelector(".files-card");
      if (!card) return "NO_CARD";
      const hit = [...card.querySelectorAll(".files-node-name")].find((el) => el.textContent === ${JSON.stringify(name)});
      if (!hit) {
        return JSON.stringify([...card.querySelectorAll(".files-node-name")].map((el) => el.textContent));
      }
      hit.scrollIntoView({ block: "nearest" });
      hit.click();
      return true;
    })()`);
    if (found === true || found === "true") return;
    if (found === "NO_CARD") throw new Error("files card disappeared from the board");
    await wait(100);
  }
  const names = await page.evalJs(`JSON.stringify([...document.querySelectorAll(".files-card .files-node-name")].map((el) => el.textContent))`);
  throw new Error(`tree node not found: ${name}; have ${names}`);
}

async function closeAllTabs(page) {
  for (let n = 0; n < 16; n++) {
    const closed = await page.evalJs(`(() => {
      const btn = document.querySelector(".files-card .files-tab-close");
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!closed) break;
    await wait(80);
  }
  await wait(150);
}

let app;
const rows = [];
try {
  app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
  const page = await connectPage(CDP_PORT);
  await page.send("Page.enable");
  await page.send("Performance.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await bootIntoFreshSession(page, "Editor large perf", { spawnTerminal: false });
  await wait(400);

  const boardId = JSON.parse(
    await page.evalJs(`window.store.boards.list().then((boards) => {
      const board = boards.find((item) => item.name === "Editor large perf") ?? boards[0];
      if (!board) throw new Error("no board");
      return JSON.stringify(board.id);
    })`),
  );

  await page.evalJs(`(async () => {
    if (typeof window.store.boards.update === "function") {
      const boards = await window.store.boards.list();
      const board = boards.find((item) => item.id === ${JSON.stringify(boardId)});
      if (board) await window.store.boards.update({ ...board, cwd: ${JSON.stringify(SCRATCH_DIR)} });
    }
    await window.store.upsert({
      id: "editor-large-perf",
      board_id: ${JSON.stringify(boardId)},
      kind: "files",
      provider: "",
      cwd: ${JSON.stringify(SCRATCH_DIR)},
      x: 40, y: 40, w: 1000, h: 700,
      resume_id: null, model: null, effort: null, system_prompt: null,
      group_id: null, label: "Perf",
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
      .find((el) => el.textContent.trim().includes("Editor large perf"))?.click()
  `);
  for (let i = 0; i < 50; i++) {
    if (await page.evalJs(`!!document.querySelector(".files-card .files-node-name")`)) break;
    await wait(100);
  }

  await page.evalJs(`(() => {
    window.__editorPerf = { longtasks: [] };
    window.__editorPerfObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__editorPerf.longtasks.push({ t: e.startTime, d: e.duration, name: e.name });
      }
    });
    try { window.__editorPerfObs.observe({ type: "longtask", buffered: true }); } catch {}
    return true;
  })()`);

  // Locate the hard refuse message / constant from the live UI copy.
  const limitHint = JSON.parse(
    await page.evalJs(`JSON.stringify({
      i18nSample: document.documentElement.lang || null,
    })`),
  );

  for (const file of files) {
    await page.evalJs(`window.__editorPerf.longtasks = []; window.__editorPerf.markOpen = performance.now(); true`);
    const heapBefore = (await page.send("Runtime.getHeapUsage")).usedSize;

    await clickNode(page, file.name);

    let painted = null;
    const openStart = Date.now();
    for (let i = 0; i < 120; i++) {
      painted = JSON.parse(
        await page.evalJs(`(() => {
          const tooLarge = !!document.querySelector(".files-editor-msg") && /512|larger|maior|too large|sem preview|no preview/i.test(document.querySelector(".files-editor-msg")?.textContent || "");
          const cm = document.querySelector(".files-card .cm-editor");
          const preview = document.querySelector(".files-card .files-editor-preview");
          const loading = document.querySelector(".files-card .files-editor-msg");
          const scroller = document.querySelector(".files-card .cm-scroller");
          const foot = document.querySelector(".files-card .card-foot")?.textContent || "";
          const tokens = (foot.match(/~[\\d.]+k?\\s*tokens/i) || [])[0] || null;
          const firstLine = cm ? (document.querySelector(".files-card .cm-line")?.textContent || null) : null;
          const previewText = preview ? (preview.textContent || "").slice(0, 80) : null;
          const plainBanner = [...document.querySelectorAll(".files-card .files-editor-msg, .files-card [class*='plainBanner']")]
            .map((el) => el.textContent || "")
            .find((tx) => /highlight|plain|degrad|fluido|smooth|fold/i.test(tx)) || null;
          const ready = tooLarge || !!(cm && firstLine) || !!(preview && previewText && !/loading|carregando/i.test(previewText));
          return JSON.stringify({
            ready, tooLarge,
            hasCm: !!cm, hasPreview: !!preview,
            firstLine, previewText, tokens, plainBanner,
            cmLines: document.querySelectorAll(".files-card .cm-line").length,
            msg: loading?.textContent || null,
            t: performance.now() - (window.__editorPerf.markOpen || 0),
          });
        })()`),
      );
      if (painted?.ready) break;
      await wait(100);
    }
    const openMs = Date.now() - openStart;
    await wait(400); // settle post-paint work

    const openTasks = JSON.parse(
      await page.evalJs(`JSON.stringify(window.__editorPerf.longtasks.filter((x) => x.t >= window.__editorPerf.markOpen))`),
    );

    // Cost probes on the live buffer (what the card holds, if any).
    const probes = JSON.parse(
      await page.evalJs(`(() => {
        const msg = document.querySelector(".files-editor-msg")?.textContent || "";
        const tooLarge = /512|larger|maior|too large|sem preview|no preview/i.test(msg);
        // Try to read length from CodeMirror if present
        const view = document.querySelector(".files-card .cm-content");
        let contentLen = 0;
        let lineCount = 0;
        try {
          // Approximate via cm-line count in DOM (viewport only) + scrollHeight heuristic
          lineCount = document.querySelectorAll(".files-card .cm-line").length;
          contentLen = (view?.textContent || "").length;
        } catch {}
        const splitProbe = (() => {
          // Reconstruct cost of full-file split the way the minimap does today:
          // only meaningful when we can get the string from React — fall back to
          // measuring split of a synthetic buffer of the same byte size.
          const bytes = ${file.bytes};
          const approx = "x".repeat(Math.min(bytes, 2_000_000));
          const t0 = performance.now();
          const lines = approx.split("\\n");
          const t1 = performance.now();
          // minimap-style loop
          const maxBars = 80;
          const step = Math.max(1, Math.ceil(lines.length / maxBars));
          let bars = 0;
          for (let i = 0; i < lines.length; i += step) bars++;
          const t2 = performance.now();
          return { splitMs: +(t1 - t0).toFixed(2), minimapLoopMs: +(t2 - t1).toFixed(2), lines: lines.length, bars };
        })();
        const tokenProbe = (() => {
          const n = ${file.bytes};
          const t0 = performance.now();
          const est = Math.ceil(n / 4);
          const t1 = performance.now();
          return { ms: +(t1 - t0).toFixed(3), est };
        })();
        const breadcrumbProbe = (() => {
          // decideBreadcrumbSymbol does content.split("\\n") — measure that alone
          const sample = "x".repeat(Math.min(${file.bytes}, 2_000_000));
          const t0 = performance.now();
          const lines = sample.split("\\n");
          const t1 = performance.now();
          return { splitMs: +(t1 - t0).toFixed(2), lines: lines.length };
        })();
        return JSON.stringify({
          tooLarge,
          msg,
          contentLen,
          viewportCmLines: lineCount,
          hasDegradedBanner: /degrad|plain|sem highlight|no highlight|large file/i.test(document.body.innerText),
          splitProbe,
          tokenProbe,
          breadcrumbProbe,
          heapUsed: performance.memory ? performance.memory.usedJSHeapSize : null,
          heapTotal: performance.memory ? performance.memory.totalJSHeapSize : null,
        });
      })()`),
    );

    // Board drag 5s with card open — long tasks during pan.
    await page.evalJs(`window.__editorPerf.markDrag = performance.now(); window.__editorPerf.longtasks = []; true`);
    const world = JSON.parse(
      await page.evalJs(`(() => {
        const w = document.querySelector(".world") || document.querySelector("[class*='world']") || document.body;
        const r = w.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`),
    );
    // Prefer empty canvas area left of the card for pan
    const panStart = JSON.parse(
      await page.evalJs(`(() => {
        const card = document.querySelector(".files-card")?.getBoundingClientRect();
        if (!card) return JSON.stringify({ x: 20, y: 200 });
        return JSON.stringify({ x: Math.max(10, card.left - 30), y: card.top + 40 });
      })()`),
    );
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: panStart.x,
      y: panStart.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    const dragEnd = Date.now() + 5000;
    let step = 0;
    while (Date.now() < dragEnd) {
      step += 1;
      const dx = Math.sin(step / 5) * 40;
      const dy = Math.cos(step / 7) * 30;
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: panStart.x + dx,
        y: panStart.y + dy,
        button: "left",
        buttons: 1,
        pointerType: "mouse",
      });
      await wait(16);
    }
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: panStart.x,
      y: panStart.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });

    const dragTasks = JSON.parse(
      await page.evalJs(`JSON.stringify(window.__editorPerf.longtasks.filter((x) => x.t >= window.__editorPerf.markDrag))`),
    );
    const heapAfter = (await page.send("Runtime.getHeapUsage")).usedSize;

    const summarize = (tasks) => {
      const over = (tasks || []).filter((t) => t.d > 50);
      return {
        count: over.length,
        maxMs: over.length ? Math.round(Math.max(...over.map((t) => t.d))) : 0,
        sumMs: Math.round(over.reduce((s, t) => s + t.d, 0)),
      };
    };

    const row = {
      file: file.name,
      lines: file.lines,
      ext: file.ext,
      bytes: file.bytes,
      opened: painted?.ready && !painted?.tooLarge && !probes.tooLarge,
      tooLarge: !!(painted?.tooLarge || probes.tooLarge),
      openMs,
      firstPaintMs: painted?.t != null ? Math.round(painted.t) : null,
      hasCm: !!painted?.hasCm,
      hasPreview: !!painted?.hasPreview,
      plainBanner: painted?.plainBanner || null,
      tokensFoot: painted?.tokens,
      openLongTasks: summarize(openTasks),
      dragLongTasks: summarize(dragTasks),
      heapBeforeMb: +(heapBefore / 1024 / 1024).toFixed(1),
      heapAfterMb: +(heapAfter / 1024 / 1024).toFixed(1),
      heapDeltaMb: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(1),
      probes,
      limitHint,
      world,
    };
    rows.push(row);
    console.log(
      `[measured] ${file.name} bytes=${file.bytes} opened=${row.opened} tooLarge=${row.tooLarge} openMs=${row.openMs} openLT=${JSON.stringify(row.openLongTasks)} dragLT=${JSON.stringify(row.dragLongTasks)} heapΔ=${row.heapDeltaMb}MB`,
    );

    await closeAllTabs(page);
    // Ensure the files card is still on the board after tab cleanup.
    if (!(await page.evalJs(`!!document.querySelector(".files-card")`))) {
      throw new Error("files card was closed during cleanup — aborting measure");
    }
  }

  const outPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(outPath, JSON.stringify({ label: LABEL, at: new Date().toISOString(), rows }, null, 2));
  console.log(`[measured][json] wrote ${outPath}`);
  console.log(`[measured][summary] ${JSON.stringify(rows.map((r) => ({
    file: r.file, bytes: r.bytes, opened: r.opened, tooLarge: r.tooLarge, openMs: r.openMs,
    openLT: r.openLongTasks, dragLT: r.dragLongTasks, heapDeltaMb: r.heapDeltaMb,
  })))}`);
} finally {
  if (app) await stopApp(app);
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}
