// End-to-end MEASUREMENT.
//
// Opens 3 sessions, each with a long-lived process that PRINTS a line and then
// stays alive ignoring HUP/TERM. Measures, with numbers:
//   - live processes (the markers) before and after leaving each session;
//   - renderer CPU (CDP Performance.TaskDuration) while LOOKING at a board and
//     then on Home — the promise is "zero render" on leaving;
//   - xterms mounted in the DOM (1 on the board, 0 on Home);
//   - on RETURNING to a session, the recent history reappears (ring replay);
//   - "Stop session" kills ONLY that one; app close kills everything.
import { execSync } from "node:child_process";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-background-session-${CDP_PORT}`, import.meta.url).pathname;
const MARK_PREFIX = "STELLAR_BGPROBE_";

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
function markerCount() {
  const pattern = `[${MARK_PREFIX[0]}]${MARK_PREFIX.slice(1)}`;
  try {
    return execSync(`pgrep -f '${pattern}' || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
async function delay(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
async function isHome(page) {
  return await page.evalJs(`!!document.querySelector('.home')`);
}
async function goHome(page) {
  if (await isHome(page)) return;
  const c = JSON.parse(
    await page.evalJs(
      `(() => { const el = document.querySelector('.topbar-home'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`,
    ),
  );
  await page.click(c.x, c.y);
  await delay(1200);
}
async function openBoardByName(page, name) {
  const clicked = await page.evalJs(`
    (() => {
      const btns = [...document.querySelectorAll('.home button')];
      const b = btns.find((x) => x.textContent.includes(${JSON.stringify(name)}));
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error(`board "${name}" não encontrado na Home`);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const title = await page.evalJs(`document.querySelector('.topbar-title')?.textContent ?? ''`);
    if (title.includes(name)) return;
    await delay(150);
  }
  throw new Error(`board "${name}" não abriu (topbar não confirmou)`);
}
/** Renderer CPU (seconds of TaskDuration) over a window of `ms`. */
async function cpuSeconds(page, ms) {
  const read = async () =>
    (await page.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;
  const before = await read();
  await delay(ms);
  const after = await read();
  return Number((after - before).toFixed(3));
}
async function xtermCount(page) {
  return await page.evalJs(`document.querySelectorAll('.xterm').length`);
}
async function cardIdForBoard(page, boardId) {
  return await page.evalJs(`
    (async () => (await window.store.list(${JSON.stringify(boardId)})).find((c) => c.kind === 'terminal')?.id ?? null)()
  `);
}
async function boardIdByName(page, name) {
  return await page.evalJs(`
    (async () => (await window.store.boards.list()).find((b) => b.name === ${JSON.stringify(name)})?.id ?? null)()
  `);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await page.send("Performance.enable");
  await delay(1000);

  const sessions = [
    { name: "BG Sessao 1", marker: `${MARK_PREFIX}1`, busy: false },
    { name: "BG Sessao 2", marker: `${MARK_PREFIX}2`, busy: false },
    // The third PRINTS continuously: it is what gives the renderer real work,
    // so the CPU measurement can tell "board on screen" from "Home".
    { name: "BG Sessao 3", marker: `${MARK_PREFIX}3`, busy: true },
  ];

  for (const s of sessions) {
    await goHome(page);
    await bootIntoFreshSession(page, s.name);
    await delay(700);
    s.boardId = await boardIdByName(page, s.name);
    s.cardId = await cardIdForBoard(page, s.boardId);
    // Prints a line and becomes a process that ignores HUP/TERM (the busy one
    // prints TICK continuously).
    const cmd = s.busy
      ? `exec sh -c 'trap "" HUP TERM; echo READY_${s.marker}; while true; do echo TICK; sleep 0.05; done' ${s.marker}`
      : `echo READY_${s.marker}; exec sh -c 'trap "" HUP TERM; while true; do sleep 1; done' ${s.marker}`;
    await toolJson("send_to_card", { target: s.cardId, text: cmd });
  }
  await delay(1500);
  check("3 processos de sessão rodando (uma por sessão)", markerCount(), 3);

  // --- while LOOKING at board 3 (terminal printing) ---
  const onBoardXterms = await xtermCount(page);
  const cpuOnBoard = await cpuSeconds(page, 3000);
  console.log(`[measured] board open: xterms=${onBoardXterms} cpu_renderer=${cpuOnBoard}s/3s`);

  // --- leave for Home: UI unmounts, processes keep running ---
  await goHome(page);
  await delay(1500);
  const homeXterms = await xtermCount(page);
  const cpuOnHome = await cpuSeconds(page, 3000);
  console.log(`[measured] Home: xterms=${homeXterms} cpu_renderer=${cpuOnHome}s/3s`);

  check("sair para a Home NÃO encerra os 3 processos (sessões vivas em segundo plano)", markerCount(), 3);
  check("nenhum xterm montado na Home (zero render da UI dos boards)", homeXterms, 0);
  check("CPU do renderer na Home não é maior que com o board na tela", cpuOnHome <= cpuOnBoard + 0.05, true);

  const bg = await page.evalJs(`(async () => JSON.stringify(await window.store.boardBackgroundStatus()))()`).then(
    JSON.parse,
  );
  check("as 3 sessões aparecem vivas no estado de fundo", bg.backgroundCount, 3);
  check(
    "...e cada board reporta vivo (bash não conta como agente, agents=0)",
    sessions.every((s) => bg.boards[s.boardId]?.alive === true && bg.boards[s.boardId]?.agents === 0),
    true,
  );

  // --- return to session 1: the recent history reappears from the ring ---
  await openBoardByName(page, sessions[0].name);
  await delay(1200);
  const rc = await toolJson("read_card", { target: sessions[0].cardId });
  const rcText = typeof rc === "string" ? rc : (rc.text ?? "");
  check("voltar para a sessão repinta o histórico recente (READY_1 no xterm)", rcText.includes(`READY_${sessions[0].marker}`), true);
  check("...e o processo da sessão 1 continua vivo", markerCount(), 3);

  // --- stop ONLY session 1 ---
  await page.evalJs(`window.store.boardStop(${JSON.stringify(sessions[0].boardId)})`);
  const stopDeadline = Date.now() + 12_000;
  let after = 3;
  while (Date.now() < stopDeadline) {
    after = markerCount();
    if (after === 2) break;
    await delay(300);
  }
  check("parar a sessão 1 mata só o processo dela (2 restantes)", after, 2);

  // --- close the app: kills everything ---
  // Through the REAL close path (the window), not the harness SIGTERM: SIGTERM
  // terminates the process without running the `closed` handler that calls
  // `registry.killAll()`, and the PTYs (own session via forkpty) would survive
  // as orphans — exactly the case this app exists to prevent.
  // No `await`: `evalJs` only resolves when the page replies, and the page
  // CLOSES — the promise would never settle and would hang the run.
  page.evalJs(`window.winControls.close()`).catch(() => {});
  const closeDeadline = Date.now() + 12_000;
  let remaining = markerCount();
  while (Date.now() < closeDeadline && remaining > 0) {
    await delay(300);
    remaining = markerCount();
  }
  check("fechar o app mata todos os processos restantes", remaining, 0);
} finally {
  finish();
  try {
    await stopApp(app);
  } catch {
    /* already stopped */
  }
  await delay(600);
  if (markerCount() > 0) {
    console.error("AVISO: processo(s) marcado(s) sobreviveram — limpando");
    try {
      execSync(`pkill -9 -f '[${MARK_PREFIX[0]}]${MARK_PREFIX.slice(1)}'`);
    } catch {
      /* nothing to do */
    }
  }
}
