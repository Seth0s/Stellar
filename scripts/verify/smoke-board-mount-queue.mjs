// Board open queue (docs/PERF.md §17): leave a dense board in S1 (home),
// reopen, and prove sequential mount (ceiling), real progress chip, and
// off-screen terminals not stuck at 80×24 after spawn-from-rect.
//
// Isolated instance only. Bash terminals (no CLI tokens). 5 reopen cycles.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const EXTRA_BASH = 7; // + the seeded board terminal = 8
const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_TOKEN = `verify-board-mount-${CDP_PORT}`;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-board-mount-queue-${CDP_PORT}`, import.meta.url).pathname;
const GEN_DIR = new URL(`../../.verify-tmp/board-mount-gen-${CDP_PORT}`, import.meta.url).pathname;
const SHOT_DIR = new URL(`../../.verify-tmp/board-mount-shots-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(GEN_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
writeFileSync(
  `${GEN_DIR}/gen.sh`,
  `#!/bin/sh
awk -v n=6000 'BEGIN {
  pad = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  for (i = 1; i <= n; i++) {
    printf "\\033[3%dmSEQ%06d %s\\033[0m\\n", i % 7 + 1, i, pad
  }
  printf "ENDMARK\\n"
}'
`,
);

let callerCardId = null;
let nextRpcId = 1;
async function callTool(name, args) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${MCP_TOKEN}`,
  };
  if (callerCardId) headers["x-stellar-caller-card"] = callerCardId;
  const res = await fetch(MCP_BASE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  const rpc = JSON.parse(line);
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}
async function waitFor(fn, { timeoutMs, everyMs = 200 }) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start >= timeoutMs) return null;
    await delay(everyMs);
  }
}
async function clickModalButton(page, label) {
  const find = async () =>
    JSON.parse(
      await page.evalJs(`
        (() => {
          const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
        })()
      `),
    );
  const coords = await waitFor(find, { timeoutMs: 8000, everyMs: 100 });
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}
async function goHome(page) {
  const c = JSON.parse(
    await page.evalJs(
      `(() => { const el = document.querySelector('.topbar-home'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`,
    ),
  );
  await page.click(c.x, c.y);
  await waitFor(async () => page.evalJs(`!!document.querySelector('.home')`), { timeoutMs: 8000, everyMs: 100 });
}
async function openBoardByName(page, name) {
  const clicked = await page.evalJs(`
    (() => {
      const b = [...document.querySelectorAll('.home button')].find((x) => x.textContent.includes(${JSON.stringify(name)}));
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error(`board "${name}" not found on Home`);
  await waitFor(async () => page.evalJs(`!!document.querySelector('.viewport') && !document.querySelector('.home')`), {
    timeoutMs: 15000,
    everyMs: 100,
  });
}

const dims = (page, id) => page.evalJs(`JSON.stringify(window.__getTerminalDims(${JSON.stringify(id)}))`).then(JSON.parse);

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_MCP_INTERNAL_TOKEN: MCP_TOKEN },
});
const BOARD = "Mount Queue";
try {
  const page = await connectPage(CDP_PORT);
  await page.send("Performance.enable");
  await delay(1200);
  await bootIntoFreshSession(page, BOARD);
  await delay(500);

  const orchId = await page.evalJs(`
    (() => {
      const el = document.querySelector('[data-role="terminal-activity"]');
      return el?.dataset?.cardId || null;
    })()
  `);
  if (!orchId) throw new Error("no seeded terminal card id in DOM after boot");
  callerCardId = orchId;
  const bashIds = [orchId];

  for (let i = 0; i < EXTRA_BASH; i++) {
    const spawnPromise = callTool("spawn_agent", {
      provider: "bash",
      reason: "smoke board mount queue density",
      label: `mount-${i}`,
      cwd: GEN_DIR,
    });
    await clickModalButton(page, "Permitir");
    const spawned = await spawnPromise;
    if (spawned.ok !== true) throw new Error(`spawn_agent failed: ${JSON.stringify(spawned)}`);
    bashIds.push(spawned.cardId);
  }

  for (let i = 0; i < 2; i++) {
    const spawnPromise = callTool("spawn_card", {
      kind: "browser",
      url: "about:blank",
      reason: "smoke board mount queue browser",
    });
    await clickModalButton(page, "Permitir");
    const spawned = await spawnPromise;
    if (spawned.ok !== true) throw new Error(`spawn_card browser failed: ${JSON.stringify(spawned)}`);
  }

  const taskPromise = callTool("spawn_card", { kind: "task", reason: "smoke board mount queue fila" });
  await clickModalButton(page, "Permitir");
  const taskSpawned = await taskPromise;
  if (taskSpawned.ok !== true) throw new Error(`spawn_card task failed: ${JSON.stringify(taskSpawned)}`);

  await delay(800);
  for (const id of bashIds) {
    void callTool("send_to_card", { target: id, text: `sh ${GEN_DIR}/gen.sh\n` });
  }
  await delay(5000);

  const beforeLeave = [];
  for (const id of bashIds) {
    beforeLeave.push({ id, cols: (await dims(page, id))?.cols ?? null });
  }
  writeFileSync(`${SHOT_DIR}/before-leave-dims.json`, JSON.stringify(beforeLeave, null, 2));

  await goHome(page);
  await delay(5000);

  const reopenMetrics = [];
  for (let round = 1; round <= 5; round++) {
    await page.evalJs(`
      (() => {
        window.__mountProbe = { longtasks: [], progressSamples: [], skeletonPeak: 0, skeletonSamples: [] };
        if (window.__mountObserver) try { window.__mountObserver.disconnect(); } catch {}
        window.__longTasks = window.__longTasks || [];
        window.__mountObserver = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__mountProbe.longtasks.push({ t: performance.now(), d: e.duration });
            window.__longTasks.push({ start: e.startTime, duration: e.duration });
          }
        });
        try { window.__mountObserver.observe({ type: 'longtask', buffered: true }); } catch {}
        window.__mountProgressTimer = setInterval(() => {
          const el = document.querySelector('[data-role="board-mount-progress"]');
          const skeletons = document.querySelectorAll('[data-role="card-skeleton"]').length;
          if (skeletons > window.__mountProbe.skeletonPeak) window.__mountProbe.skeletonPeak = skeletons;
          window.__mountProbe.skeletonSamples.push(skeletons);
          if (el) window.__mountProbe.progressSamples.push(el.textContent.trim());
        }, 40);
        return true;
      })()
    `);

    const t0 = Date.now();
    const perf0 = await page.evalJs(`performance.now()`);
    const cpu0 = (await page.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;
    await openBoardByName(page, BOARD);

    if (round === 1) {
      const sawProgress = await waitFor(
        async () => page.evalJs(`!!document.querySelector('[data-role="board-mount-progress"]')`),
        { timeoutMs: 5000, everyMs: 40 },
      );
      if (sawProgress) {
        const mid = await page.send("Page.captureScreenshot", { format: "png" });
        if (mid?.data) writeFileSync(`${SHOT_DIR}/round1-progress.png`, Buffer.from(mid.data, "base64"));
      }
    }

    const done = await waitFor(
      async () =>
        page.evalJs(`
          (() => {
            const skeletons = document.querySelectorAll('[data-role="card-skeleton"]').length;
            const progress = document.querySelector('[data-role="board-mount-progress"]');
            return skeletons === 0 && !progress ? 'done' : null;
          })()
        `),
      { timeoutMs: 45000, everyMs: 100 },
    );
    const timeToUsableMs = Date.now() - t0;
    await delay(600);
    const cpu1 = (await page.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;

    const probe = JSON.parse(
      await page.evalJs(`
        (() => {
          clearInterval(window.__mountProgressTimer);
          try { window.__mountObserver?.disconnect(); } catch {}
          const after = ${perf0};
          const long = (window.__longTasks || []).filter((t) => t.start >= after);
          return JSON.stringify({
            probe: window.__mountProbe,
            longAfterOpen: long,
            skeletonsLeft: document.querySelectorAll('[data-role="card-skeleton"]').length,
            progressGone: !document.querySelector('[data-role="board-mount-progress"]'),
            cardFrames: document.querySelectorAll('.card-frame').length,
          });
        })()
      `),
    );

    const afterDims = [];
    for (const id of bashIds) {
      afterDims.push({ id, cols: (await dims(page, id))?.cols ?? null, rows: (await dims(page, id))?.rows ?? null });
    }
    const stuck80 = afterDims.filter((d) => d.cols === 80);
    const longMax = Math.max(0, ...probe.longAfterOpen.map((t) => t.duration), 0);
    const longSum = probe.longAfterOpen.reduce((s, t) => s + t.duration, 0);

    const metric = {
      round,
      done,
      timeToUsableMs,
      taskDurationDelta: cpu1 - cpu0,
      longMax: Math.round(longMax),
      longSum: Math.round(longSum),
      longCount: probe.longAfterOpen.length,
      skeletonPeak: probe.probe.skeletonPeak,
      progressSamples: probe.probe.progressSamples.slice(0, 12),
      stuck80Count: stuck80.length,
      cardFrames: probe.cardFrames,
    };
    reopenMetrics.push(metric);
    writeFileSync(`${SHOT_DIR}/round-${round}.json`, JSON.stringify({ metric, afterDims }, null, 2));

    check(`round ${round}: mount finished (no skeletons, progress gone)`, done === "done" && probe.skeletonsLeft === 0, true);
    check(`round ${round}: progress chip observed while opening`, probe.probe.progressSamples.length > 0, true);
    check(`round ${round}: skeleton peak covers multiple cards`, probe.probe.skeletonPeak >= 2, true);
    check(`round ${round}: no terminal left at default 80 cols`, stuck80.length, 0);

    if (round === 1) {
      const png = await page.send("Page.captureScreenshot", { format: "png" });
      if (png?.data) {
        writeFileSync(`${SHOT_DIR}/round1-board.png`, Buffer.from(png.data, "base64"));
      }
    }

    await goHome(page);
    await delay(1200);
  }

  const worstMs = Math.max(...reopenMetrics.map((m) => m.timeToUsableMs));
  const worstLong = Math.max(...reopenMetrics.map((m) => m.longMax));
  writeFileSync(`${SHOT_DIR}/summary.json`, JSON.stringify({ reopenMetrics, worstMs, worstLong }, null, 2));
  check("5 reopen cycles completed", reopenMetrics.length, 5);
  check("worst time-to-usable under 45s", worstMs < 45000, true);
  console.log(JSON.stringify({ reopenMetrics, worstMs, worstLong, shotDir: SHOT_DIR }, null, 2));
} finally {
  await stopApp(app);
  try {
    rmSync(GEN_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
finish();
