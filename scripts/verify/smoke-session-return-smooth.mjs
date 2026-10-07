// Regression for the leave-the-session-and-come-back path (dense replay, geometry, wheel).
//
// The owner's report: after leaving the session and returning, terminal scroll
// does not work and the drawing freezes and glitches. Four cards each hold up to
// 2 MB in the main ring; on return every card replays its ring into a brand-new
// xterm. This smoke MEASURES, in an isolated instance, what that return costs
// and whether the history comes back right:
//   - renderer blocking right after the return (longtask API, plus CDP
//     Performance.TaskDuration) — the replay must not freeze the event loop;
//   - the replay lands at the card's REAL width: a cursor-addressed marker
//     (`ESC[<col>G`) printed at a wide column must still be at that column,
//     not clamped by a 80x24 default geometry;
//   - history is complete exactly once: the numbered lines are consecutive,
//     none duplicated, none missing, and the end marker appears once;
//   - the wheel scrolls the buffer right after the return.
// Bash cards only (no CLI, no token). Isolated userData/port.
import { mkdirSync, writeFileSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CARDS = 4;
const LINES = 12_000; // ~1.8 MB per card, just under the 2 MB ring
const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-session-return-smooth-${CDP_PORT}`, import.meta.url).pathname;
const GEN_DIR = new URL(`../../.verify-tmp/session-return-gen-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Generator: LINES numbered ~150-byte colored lines, a cursor-addressed BOX marker
// every 500 lines, and an end marker. Args: tag, boxCol.
mkdirSync(GEN_DIR, { recursive: true });
writeFileSync(
  `${GEN_DIR}/gen.sh`,
  `#!/bin/sh
awk -v n=${LINES} -v tag="$1" -v col="$2" 'BEGIN {
  pad = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  for (i = 1; i <= n; i++) {
    printf "\\033[3%dmSEQ%06d %s\\033[0m", i % 7 + 1, i, pad
    if (i % 500 == 0) printf "\\033[%dGBOX%06d", col, i
    printf "\\n"
  }
  printf "ENDMARK_%s\\n", tag
}'
`,
);

let mcpUrl = MCP_BASE;
let nextRpcId = 1;
async function callTool(name, args) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  const rpc = JSON.parse(line);
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}
async function waitFor(fn, { timeoutMs, everyMs = 500 }) {
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
}
/** The card whose xterm is attached to the DOM AND whose body shows inside the
 *  window (cards are laid out on a big canvas, so a body's own center can lie off
 *  screen), with a point inside that visible part; or null. */
async function onScreenCard(page) {
  return JSON.parse(
    await page.evalJs(`(() => {
      for (const el of document.querySelectorAll('[data-role="terminal-activity"]')) {
        const body = el.parentElement?.querySelector('[data-role="terminal-body"]');
        if (!body || !body.querySelector('.xterm')) continue;
        const r = body.getBoundingClientRect();
        const left = Math.max(r.left, 0), right = Math.min(r.right, window.innerWidth);
        const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
        if (right - left < 40 || bottom - top < 40) continue;
        const x = (left + right) / 2, y = (top + bottom) / 2;
        if (!body.contains(document.elementFromPoint(x, y))) continue;
        return JSON.stringify({ id: el.dataset.cardId, x, y });
      }
      return JSON.stringify(null);
    })()`),
  );
}
async function wheelUp(page, at, notches = 5) {
  for (let i = 0; i < notches; i++) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -300, pointerType: "mouse" });
    await delay(60);
  }
  await delay(600);
}
const dims = (page, id) => page.evalJs(`JSON.stringify(window.__getTerminalDims(${JSON.stringify(id)}))`).then(JSON.parse);
const scrollPos = (page, id) => page.evalJs(`JSON.stringify(window.__getTerminalScrollPos(${JSON.stringify(id)}))`).then(JSON.parse);

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await page.send("Performance.enable");
  await delay(1000);
  // Long-task recorder, installed once (the page context survives the Home round trip).
  await page.evalJs(`
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ entryTypes: ["longtask"] });
    true
  `);

  await bootIntoFreshSession(page, "Return Smooth");
  await delay(500);
  const listed = await callTool("list_cards", {});
  const orchId = listed.cards.find((c) => c.kind === "terminal").id;
  mcpUrl = `${MCP_BASE}?card=${encodeURIComponent(orchId)}`;
  const ids = [orchId];
  for (let i = 1; i < CARDS; i++) {
    const spawnPromise = callTool("spawn_agent", { provider: "bash", reason: "smoke session return", label: `return-${i}` });
    await clickModalButton(page, "Permitir");
    const spawned = await spawnPromise;
    if (spawned.ok !== true) throw new Error(`spawn_agent failed: ${JSON.stringify(spawned)}`);
    ids.push(spawned.cardId);
  }
  await delay(1000);
  check(`${CARDS} terminais bash no board`, ids.length, CARDS);

  const widths = [];
  for (const id of ids) widths.push((await dims(page, id))?.cols ?? 0);
  const boxCol = Math.max(40, Math.min(...widths) - 14);
  console.log(`[measured] cols per card before leaving: ${widths.join(",")} -> BOX column ${boxCol}`);
  check("os cards são mais largos que o default 80 (senão o repro não discrimina)", Math.min(...widths) > 90, true);

  // Fill every card (~1.8 MB each) and wait for the end marker in its xterm.
  ids.forEach((id, k) => void callTool("send_to_card", { target: id, text: `sh ${GEN_DIR}/gen.sh c${k} ${boxCol}` }));
  for (const [k, id] of ids.entries()) {
    const done = await waitFor(async () => ((await callTool("read_card", { target: id, lines: 5 })).text ?? "").includes(`ENDMARK_c${k}`), { timeoutMs: 120_000, everyMs: 1000 });
    check(`card ${k}: a saída densa terminou`, !!done, true);
  }

  // Control: the wheel on the same on-screen card BEFORE leaving, so the number
  // after the return has a baseline (each notch is 10 lines).
  const ctrlCard = await onScreenCard(page);
  check("há um card com xterm montado na tela antes de sair", !!ctrlCard, true);
  const ctrlBefore = await scrollPos(page, ctrlCard.id);
  await wheelUp(page, ctrlCard);
  const ctrlAfter = await scrollPos(page, ctrlCard.id);
  const ctrlLines = ctrlBefore.viewportY - ctrlAfter.viewportY;
  console.log(`[measured] wheel before leaving (card ${ctrlCard.id}): ${ctrlLines} lines for 5 notches`);
  check("a roda rola o buffer antes de sair (baseline: 5 giros)", ctrlLines > 0, true);
  await page.evalJs(`window.__scrollTerminalLinesForTest(${JSON.stringify(ctrlCard.id)}, 100000)`);

  // Leave the session, stay away, come back.
  const boardName = "Return Smooth";
  await goHome(page);
  await delay(5000);
  const t0 = await page.evalJs(`performance.now()`);
  const cpu0 = (await page.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;
  await openBoardByName(page, boardName);
  // Observe the return for a fixed window, with no interaction.
  await delay(8000);
  const cpu1 = (await page.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;
  const tasks = JSON.parse(await page.evalJs(`JSON.stringify(window.__longTasks.filter((t) => t.start >= ${t0}))`));
  const maxBlock = Math.round(Math.max(0, ...tasks.map((t) => t.duration)));
  const totalBlock = Math.round(tasks.reduce((s, t) => s + t.duration, 0));
  console.log(`[measured] return: renderer TaskDuration=${(cpu1 - cpu0).toFixed(3)}s, longtasks=${tasks.length}, max=${maxBlock}ms, sum=${totalBlock}ms`);
  // What dominates this number is the one-time WebGL shader compile of the card
  // that opens (measured: getShaderParameter 105-222 ms of ~350 ms; the 8 MB of
  // replay is parsed in time-boxed slices by xterm's own write buffer and adds
  // ~100 ms in total). The bound is a regression guard against the replay going
  // monolithic, not a claim that the return is free.
  check("nenhuma tarefa longa do renderer passa de 600 ms na volta", maxBlock <= 600, true);

  for (const [k, id] of ids.entries()) {
    const d = await dims(page, id);
    check(`card ${k}: xterm voltou com a largura real do card (>90 colunas)`, (d?.cols ?? 0) > 90, true);
    const text = (await callTool("read_card", { target: id, lines: 100000 })).text ?? "";
    const seqs = [...text.matchAll(/SEQ(\d{6})/g)].map((m) => Number(m[1]));
    const consecutive = seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1);
    check(`card ${k}: histórico voltou, numerado e consecutivo (sem buraco nem duplicata)`, seqs.length > 5000 && consecutive, true);
    check(`card ${k}: a última linha (SEQ${String(LINES).padStart(6, "0")}) aparece uma vez`, seqs.filter((n) => n === LINES).length, 1);
    check(`card ${k}: o marcador de fim aparece uma vez`, text.split(`ENDMARK_c${k}`).length - 1, 1);
    // The cursor-addressed marker must sit at the column it was printed for.
    const boxLine = text.split("\n").find((l) => l.includes(`BOX${String(LINES).padStart(6, "0")}`)) ?? "";
    check(`card ${k}: o marcador endereçado (ESC[${boxCol}G) segue na coluna ${boxCol}`, boxLine.indexOf("BOX") + 1 === boxCol, true);
  }

  // Wheel right after the return scrolls the buffer like it did before leaving.
  const back = await onScreenCard(page);
  check("há um card com xterm montado na tela depois de voltar", !!back, true);
  const before = await scrollPos(page, back.id);
  await wheelUp(page, back);
  const afterPos = await scrollPos(page, back.id);
  const moved = before.viewportY - afterPos.viewportY;
  console.log(`[measured] wheel after return (card ${back.id}): ${moved} lines for 5 notches (baseY ${afterPos.baseY})`);
  check("a roda rola o buffer logo após a volta, no mesmo avanço do baseline", moved > 0 && moved >= ctrlLines * 0.8, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
