// Live MEASUREMENT + correctness smoke for off-viewport terminal rendering and
// the PTY environment filter.
//
// Two things are proven against a REAL isolated instance (never the owner's):
//
// 1. ENV: a command run inside a card must NOT see the parent app's identity
//    (`CHROME_DESKTOP`) and MUST still see `AGENT_CANVAS_*`.
// 2. DRAW: with 8 cards each emitting a continuous spinner, the renderer and
//    the GPU process must spend clearly LESS CPU when most cards are off the
//    viewport (the xterm write is skipped) than when all are on screen. The
//    bytes that were produced while off screen must reappear, once, on return.
//
// The board is set up deterministically: eight terminal rows are written to the
// store in a grid that fits the window at the camera the app resets to on every
// board load (pan 0,0 / zoom 1), then the board is reopened so the cards mount
// at those rects. Creating them through the rail stacks them thousands of world
// units apart (measured in scripts/measure/perf-idle-cards.mjs), which cannot
// be made to fit at the app's minimum zoom.
//
// CPU is read from /proc per Stellar process (main / renderer / gpu-process),
// the same technique as scripts/measure/perf-idle-cards.mjs — no mocking.
import { readFileSync, readdirSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-render-${CDP_PORT}`, import.meta.url).pathname;
const SPINNER = new URL("../measure/fixtures/idle-tui.mjs", import.meta.url).pathname;
const BOARD_NAME = "Smoke Render Offscreen";
const CARDS = 8;
const SAMPLE_SECONDS = 8;
const WATCHDOG_MS = 300_000;
const CLK_TCK = 100; // Linux _SC_CLK_TCK.

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Debug aid: with SMOKE_DEBUG=1, console.log is mirrored to stderr, which Node
// writes synchronously to a file. Stdout redirected to a file is block-buffered,
// so without this a stall is invisible until the buffer fills.
if (process.env.SMOKE_DEBUG === "1") {
  console.log = (...args) => process.stderr.write(`${args.join(" ")}\n`);
}

/** Processes in the app's own tree (the harness spawns Electron `detached`). */
function treePids(rootPid) {
  const byParent = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(Number(entry));
    } catch {
      // died between readdir and read
    }
  }
  const out = [];
  const walk = (pid) => {
    for (const child of byParent.get(pid) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(rootPid);
  return out;
}

/** utime+stime ticks and the `--type=` bucket of one pid. */
function readProc(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const cpuTicks = Number(fields[11]) + Number(fields[12]);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? (cmdline.includes("out/main/index.js") ? "electron-main" : "cli");
    return { pid, cpuTicks, type };
  } catch {
    return null;
  }
}

/** Machine-wide activity over the window — so a number is not read as "the
 *  fix" when it is really another process on the shared machine. */
function machineBusyTicks() {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  const total = nums.reduce((a, b) => a + b, 0);
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
  return { total, busy: total - idle };
}

/** CPU% per process bucket over `seconds`, from /proc deltas. */
async function sampleCpu(appPid, seconds) {
  const before = new Map();
  for (const pid of treePids(appPid)) {
    const p = readProc(pid);
    if (p) before.set(pid, p);
  }
  const busy0 = machineBusyTicks();
  const t0 = Date.now();
  await delay(seconds * 1000);
  const elapsed = (Date.now() - t0) / 1000;
  const busy1 = machineBusyTicks();
  const byType = {};
  for (const pid of treePids(appPid)) {
    const now = readProc(pid);
    const prev = before.get(pid);
    if (!now) continue;
    const pct = prev ? ((now.cpuTicks - prev.cpuTicks) / (elapsed * CLK_TCK)) * 100 : 0;
    byType[now.type] = (byType[now.type] ?? 0) + pct;
  }
  const machineBusyPct = busy1.total > busy0.total ? ((busy1.busy - busy0.busy) / (busy1.total - busy0.total)) * 100 : 0;
  return { elapsed, byType, machineBusyPct };
}

let nextRpcId = 1;
async function toolJson(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  const rpc = JSON.parse(line);
  if (rpc.error) throw new Error(JSON.stringify(rpc.error));
  return JSON.parse(rpc.result.content[0].text);
}

async function readCardText(cardId, lines = 40) {
  const res = await toolJson("read_card", { target: cardId, lines });
  return typeof res === "string" ? res : (res.text ?? "");
}

async function goHome(page) {
  const onHome = await page.evalJs(`!!document.querySelector('.home')`);
  if (onHome) return;
  await page.evalJs(`document.querySelector('.topbar-home')?.click()`);
  await delay(1200);
}

async function openBoardByName(page, name) {
  const clicked = await page.evalJs(`(() => {
    const b = [...document.querySelectorAll('.home button')].find((x) => x.textContent.includes(${JSON.stringify(name)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`board "${name}" not found on Home`);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const title = await page.evalJs(`document.querySelector('.topbar-title')?.textContent ?? ''`);
    if (title.includes(name)) return;
    await delay(150);
  }
  throw new Error(`board "${name}" did not open`);
}

/** Writes N terminal rows in a grid that fits the window at zoom 1. */
async function seedGrid(page, boardId, cwd, count) {
  return JSON.parse(
    await page.evalJs(`(async () => {
      const w = innerWidth, h = innerHeight;
      const cols = 4, rows = Math.ceil(${count} / 4);
      const cellW = Math.floor((w - 80) / cols), cellH = Math.floor((h - 80) / rows);
      const now = Date.now();
      const ids = [];
      for (let i = 0; i < ${count}; i++) {
        const id = "seed" + i;
        ids.push(id);
        const col = i % cols, row = Math.floor(i / cols);
        await window.store.upsert({
          id, provider: "bash", cwd: ${JSON.stringify(cwd)},
          x: 40 + col * cellW, y: 40 + row * cellH, w: cellW - 24, h: cellH - 24,
          updated_at: now, resume_id: null, model: null, system_prompt: null, kind: "terminal",
          board_id: ${JSON.stringify(boardId)}, group_id: null, label: null, messages_json: null,
          archived_at: null, effort: null, created_at: now,
        });
      }
      return JSON.stringify(ids);
    })()`),
  );
}

async function terminalCardIds(page, boardId) {
  return JSON.parse(
    await page.evalJs(`(async () => {
      const cards = await window.store.list(${JSON.stringify(boardId)});
      return JSON.stringify(cards.filter((c) => c.kind === "terminal").map((c) => c.id));
    })()`),
  );
}

/** Terminal cards currently intersecting the window (all / by id). */
async function cardsOnScreen(page) {
  return JSON.parse(
    await page.evalJs(`(() => {
      const els = [...document.querySelectorAll('[data-kind="terminal"]')];
      const onIds = [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (el.isConnected && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) {
          onIds.push(el.querySelector('[data-card-id]')?.getAttribute('data-card-id') ?? null);
        }
      }
      return JSON.stringify({ total: els.length, on: onIds.length, onIds });
    })()`),
  );
}

async function setZoom(page, pct) {
  await page.evalJs(`document.querySelector('.zoom-readout')?.click()`);
  await delay(200);
  const focused = await page.evalJs(`(() => {
    const inp = document.querySelector('.zoom-input');
    if (!inp) return false;
    inp.focus();
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(inp, ${JSON.stringify(String(pct))});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return document.activeElement === inp;
  })()`);
  if (!focused) throw new Error("zoom input did not focus");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await delay(500);
}

/** A point in the viewport that is NOT over any card (so a drag pans the
 *  camera instead of moving a card) AND that leaves room for the drag in the
 *  requested direction. Found dynamically: after a pan the empty space moves,
 *  and a fixed corner stops being background. */
async function findEmptyPoint(page, dx, dy) {
  return JSON.parse(
    await page.evalJs(`(() => {
      const minX = 30, maxX = innerWidth - 30, minY = 140, maxY = innerHeight - 30;
      const startY = ${dy} < 0 ? maxY : minY, stepY = ${dy} < 0 ? -24 : 24;
      const startX = ${dx} < 0 ? maxX : minX, stepX = ${dx} < 0 ? -24 : 24;
      for (let y = startY; ${dy} < 0 ? y >= minY : y <= maxY; y += stepY) {
        if (y + ${dy} < 10 || y + ${dy} > innerHeight - 10) continue;
        for (let x = startX; ${dx} < 0 ? x >= minX : x <= maxX; x += stepX) {
          if (x + ${dx} < 10 || x + ${dx} > innerWidth - 10) continue;
          const el = document.elementFromPoint(x, y);
          if (!el) continue;
          if (el.closest('[data-kind]') || el.closest('.topbar') || el.closest('.rail') || el.closest('.zoom-pill')) continue;
          return JSON.stringify({ x, y });
        }
      }
      return JSON.stringify(null);
    })()`),
  );
}

/** One drag, small enough that a start point with room for it exists. */
async function dragOnce(page, dx, dy) {
  const start = await findEmptyPoint(page, dx, dy);
  if (!start) throw new Error(`no empty background point to pan from (${dx},${dy})`);
  const x0 = start.x;
  const y0 = start.y;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, pointerType: "mouse" });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x0 + Math.round((dx * i) / steps),
      y: y0 + Math.round((dy * i) / steps),
      button: "left",
      pointerType: "mouse",
    });
    await delay(16);
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x0 + dx, y: y0 + dy, button: "left", clickCount: 1, pointerType: "mouse" });
  await delay(300);
}

/** Pan the background by (dx, dy) screen px, split into gestures no larger than
 *  the viewport (a single drag longer than the window has no valid start point
 *  with room for it). Keeps the total applied so it can be undone. */
const appliedPan = { x: 0, y: 0 };
async function panBackground(page, dx, dy) {
  const { w, h } = JSON.parse(await page.evalJs(`JSON.stringify({ w: innerWidth, h: innerHeight })`));
  const maxStepX = Math.max(80, Math.floor(w * 0.6));
  const maxStepY = Math.max(80, Math.floor(h * 0.6));
  const parts = Math.max(1, Math.ceil(Math.max(Math.abs(dx) / maxStepX, Math.abs(dy) / maxStepY)));
  for (let i = 0; i < parts; i++) {
    await dragOnce(page, Math.round(dx / parts), Math.round(dy / parts));
  }
  appliedPan.x += dx;
  appliedPan.y += dy;
}

/** Push cards off screen until at most `target` remain visible. Small steps so
 *  it stops near `target` instead of overshooting to zero. Returns how many are
 *  still on screen. */
async function leaveFewCards(page, target) {
  const { h } = JSON.parse(await page.evalJs(`JSON.stringify({ h: innerHeight })`));
  let s = await cardsOnScreen(page);
  for (let i = 0; i < 14 && s.on > target; i++) {
    await panBackground(page, 0, -Math.round(h * 0.22));
    s = await cardsOnScreen(page);
  }
  return s;
}

/** Undo whatever `leaveFewCards` panned (pan is a plain screen-pixel offset). */
async function restoreCamera(page) {
  if (appliedPan.x === 0 && appliedPan.y === 0) return;
  const dx = -appliedPan.x;
  const dy = -appliedPan.y;
  await panBackground(page, dx, dy);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, timeoutMs: 60_000 });
const measured = {};
let lastPhase = "start";
const phase = (name) => {
  lastPhase = name;
  if (process.env.SMOKE_DEBUG === "1") process.stderr.write(`[phase] ${name}\n`);
  console.log(`[phase] ${name}`);
};
// A stall must fail fast and name itself, not hang the suite: the harness is
// used by CI and a hung instance would block every later smoke.
const watchdog = setTimeout(async () => {
  console.error(`[smoke] TIMEOUT after ${WATCHDOG_MS}ms — last phase: ${lastPhase}`);
  console.error(`[measured][json] ${JSON.stringify(measured)}`);
  // process.exit skips the `finally`; kill the instance here so a stalled run
  // never leaves an Electron tree behind for the next smoke.
  try {
    await stopApp(app);
  } catch {
    /* already stopped */
  }
  process.exit(1);
}, WATCHDOG_MS);
try {
  phase("connect");
  const page = await connectPage(CDP_PORT);
  await delay(1000);

  phase("seed grid");
  await bootIntoFreshSession(page, BOARD_NAME, { spawnTerminal: false });
  const boardId = await page.evalJs(`window.store.boards.list().then((b) => (b.length > 0 ? b[0].id : null))`);
  const cwd = await page.evalJs(`window.system.homeDir`);
  if (!boardId) throw new Error("no active board after bootIntoFreshSession");
  const seeded = await seedGrid(page, boardId, cwd, CARDS);
  await goHome(page);
  await openBoardByName(page, BOARD_NAME);

  phase("wait for terminals");
  let ids = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    ids = await terminalCardIds(page, boardId);
    const registered = await page.evalJs(
      `JSON.stringify(${JSON.stringify(seeded)}.filter((id) => typeof window.__getTerminalDims?.(id) === "object"))`,
    );
    if (ids.length === CARDS && JSON.parse(registered).length === CARDS) break;
    await delay(250);
  }
  check(`${CARDS} cards de terminal montados`, ids.length, CARDS);
  const visibleAtStart = await cardsOnScreen(page);
  measured.cardsOnScreenAtStart = visibleAtStart.on;
  if (visibleAtStart.on < CARDS - 1) {
    phase("zoom to fit");
    await setZoom(page, 45);
  }
  check("os 8 cards cabem na viewport (grid semeada caber no zoom 1)", (await cardsOnScreen(page)).on >= CARDS - 1, true);

  // ---- 1. Environment filter, measured from INSIDE a card.
  phase("env probe");
  const probeCard = ids[0];
  // One short line per variable: a single long line wraps in a narrow card, and
  // xterm's translateToString joins wrapped rows, which breaks a substring test.
  await page.evalJs(
    `window.pty.write(${JSON.stringify(probeCard)}, ${JSON.stringify(
      `printf 'PROBE_CHROME=%s\\n' "\${CHROME_DESKTOP-UNSET}"; printf 'PROBE_ORIGINAL=%s\\n' "\${ORIGINAL_XDG_CURRENT_DESKTOP-UNSET}"; printf 'PROBE_AGENT=%s\\n' "\${AGENT_CANVAS_CARD_ID-UNSET}"\r`,
    )}, "human")`,
  );
  await delay(1200);
  const probeText = await readCardText(probeCard, 50);
  measured.envProbe = probeText.split("\n").filter((l) => l.includes("PROBE_")).join(" | ");
  if (process.env.SMOKE_DEBUG === "1") process.stderr.write(`[envprobe] ${JSON.stringify(probeText)}\n`);
  check("env do card NÃO tem CHROME_DESKTOP", /PROBE_CHROME=UNSET/.test(probeText), true);
  check("env do card NÃO tem ORIGINAL_XDG_CURRENT_DESKTOP", /PROBE_ORIGINAL=UNSET/.test(probeText), true);
  check("env do card MANTÉM AGENT_CANVAS_CARD_ID", probeText.includes(`PROBE_AGENT=${probeCard}`), true);

  // ---- 2. Replay correctness, on a card that goes off screen while a shell
  // command runs. This runs BEFORE the spinners so the card is still a shell.
  phase("replay: pan off");
  const few = await leaveFewCards(page, 2);
  const offIds = ids.filter((id) => !few.onIds.includes(id));
  if (offIds.length === 0) throw new Error("no card was pushed off the viewport for the replay test");
  const replayCard = offIds[0];
  phase("replay: write");
  await page.evalJs(
    `window.pty.write(${JSON.stringify(replayCard)}, ${JSON.stringify(
      `for i in 1 2 3; do printf 'REPLAY_A_%s\\n' "$i"; sleep 1; done\r`,
    )}, "human")`,
  );
  // All three markers must be produced WHILE the card is off screen, so the
  // wait covers the whole loop (3 × 1s) before the camera comes back.
  phase("replay: wait");
  await delay(3600);
  // read_card WHILE the card is still off the viewport: it must apply the held
  // bytes to the xterm before answering (flush-then-read), not return the stale
  // screen. This is the case the orchestrator reads against all the time.
  phase("replay: read while off");
  const offReadText = await readCardText(replayCard, 80);
  measured.offscreenReadMarkers = ["REPLAY_A_1", "REPLAY_A_2", "REPLAY_A_3"].map(
    (m) => offReadText.split(m).length - 1,
  );
  check(
    "read_card de um card FORA da tela devolve a saída retida",
    measured.offscreenReadMarkers.every((n) => n >= 1),
    true,
  );
  phase("replay: restore");
  await restoreCamera(page);
  await delay(900);
  phase("replay: read after return");
  const replayText = await readCardText(replayCard, 80);
  measured.replayMarkers = ["REPLAY_A_1", "REPLAY_A_2", "REPLAY_A_3"].map((m) => replayText.split(m).length - 1);
  check("o replay repõe TODOS os marcadores impressos fora da tela", measured.replayMarkers.every((n) => n >= 1), true);
  check("o replay não DUPLICA nenhum marcador", measured.replayMarkers.every((n) => n === 1), true);

  // ---- 3. Eight cards, each running a continuous synthetic TUI spinner.
  phase("start spinners");
  for (const id of ids) {
    await page.evalJs(
      `window.pty.write(${JSON.stringify(id)}, ${JSON.stringify(`"$AGENT_CANVAS_NODE" ${SPINNER} 20\r`)}, "human")`,
    );
  }
  await delay(3000);

  // ---- 3a. All cards on screen (the expensive case).
  const allShown = await cardsOnScreen(page);
  measured.allVisibleCardsOnScreen = allShown.on;
  phase("sample all-visible");
  const onScreen = await sampleCpu(app.proc.pid, SAMPLE_SECONDS);
  measured.allVisible = onScreen;
  console.log(
    `[measured] all visible (cardsOn=${allShown.on}): ${JSON.stringify(onScreen.byType)} machineBusy=${onScreen.machineBusyPct.toFixed(1)}%`,
  );

  // ---- 3b. Most cards off the viewport (the case under test).
  phase("push cards offscreen");
  const mostlyOff = await leaveFewCards(page, 2);
  measured.offscreenCardsOnScreen = mostlyOff.on;
  phase("sample offscreen");
  const offScreen = await sampleCpu(app.proc.pid, SAMPLE_SECONDS);
  measured.mostlyOffscreen = offScreen;
  console.log(
    `[measured] mostly offscreen (cardsOn=${mostlyOff.on}): ${JSON.stringify(offScreen.byType)} machineBusy=${offScreen.machineBusyPct.toFixed(1)}%`,
  );

  check("a montagem de teste deixou a maioria dos cards fora da viewport", mostlyOff.on <= 3, true);
  check("a montagem de teste tinha a maioria dos cards na viewport", allShown.on >= CARDS - 2, true);

  const onRenderer = onScreen.byType.renderer ?? 0;
  const onGpu = onScreen.byType["gpu-process"] ?? 0;
  const offRenderer = offScreen.byType.renderer ?? 0;
  const offGpu = offScreen.byType["gpu-process"] ?? 0;
  measured.deltaRendererPct = Number((onRenderer - offRenderer).toFixed(2));
  measured.deltaGpuPct = Number((onGpu - offGpu).toFixed(2));
  const onTotal = onRenderer + onGpu;
  const offTotal = offRenderer + offGpu;
  measured.ratioOffToOn = onTotal > 0 ? Number((offTotal / onTotal).toFixed(2)) : null;
  console.log(
    `[measured] renderer ${onRenderer.toFixed(1)}% -> ${offRenderer.toFixed(1)}%; gpu ${onGpu.toFixed(1)}% -> ${offGpu.toFixed(1)}%; ` +
      `total ratio off/on = ${measured.ratioOffToOn} (Δrenderer ${measured.deltaRendererPct}pp, Δgpu ${measured.deltaGpuPct}pp)`,
  );
  check("CPU do renderer NÃO sobe com os cards fora da viewport", offRenderer <= onRenderer + 0.5, true);
  check("CPU do gpu-process NÃO sobe com os cards fora da viewport", offGpu <= onGpu + 0.5, true);
  check("renderer+gpu caem com a maioria fora da viewport (off < on)", offTotal < onTotal, true);
} finally {
  clearTimeout(watchdog);
  // Emitted on stderr too so a FAILED run (which exits from `finish()` before
  // stdout flushes) still leaves the measured numbers behind.
  process.stderr.write(`[measured][json] ${JSON.stringify(measured)}\n`);
  console.log(`\n[measured][json] ${JSON.stringify(measured)}`);
  try {
    await stopApp(app);
  } catch {
    /* already stopped */
  }
  finish();
}
