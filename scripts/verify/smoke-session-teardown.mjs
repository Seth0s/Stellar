// Counterpart of the old session-teardown smoke.
//
// BEFORE: leaving a session terminated its processes; the card unmount called
// `pty.kill` and main killed immediately.
//
// NOW: leaving a session UNMOUNTS the UI (zero render) but KEEPS the processes
// alive; an EXPLICIT "Stop session" is what kills. This file proves both halves
// and keeps the signal-LADDER proof (a process that ignores HUP/TERM only dies
// on SIGKILL) for the explicit-stop path.
import { execSync } from "node:child_process";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-session-teardown-${CDP_PORT}`, import.meta.url).pathname;
const MARKER = "STELLAR_TEARDOWN_PROBE";

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
/** `pgrep -f` matches the whole argv, so the marker must be IN the probed
 * process's argv — a `# comment` disappears in the shell parse and would not
 * show up. The `[S]` in the pattern keeps the `pgrep`/shell command line itself
 * from matching the literal (the probe seeing itself). */
function markerAlive() {
  const pattern = `[${MARKER[0]}]${MARKER.slice(1)}`;
  try {
    return execSync(`pgrep -f '${pattern}' || true`, { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}
async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}
async function centerOf(page, selector) {
  return JSON.parse(
    await page.evalJs(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify(null); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`,
    ),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "Sessao A");
  await new Promise((r) => setTimeout(r, 700));

  const boardId = await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      return boards.find((b) => b.name === "Sessao A")?.id ?? boards[0].id;
    })()
  `);
  const bashA = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  // `exec` makes the PTY process BECOME a shell that ignores HUP and TERM: only
  // the last ladder step (SIGKILL) terminates it. This is the real case of an
  // agent CLI with a shutdown handler.
  await toolJson("send_to_card", {
    target: bashA,
    text: `exec sh -c 'trap "" HUP TERM; while true; do sleep 1; done' ${MARKER}`,
  });
  await new Promise((r) => setTimeout(r, 2000));
  check("o processo que resiste a HUP/TERM está rodando no card", markerAlive(), true);

  // --- leave the session: NOW the process STAYS alive ---
  const homeBtn = await centerOf(page, ".topbar-home");
  await page.click(homeBtn.x, homeBtn.y);
  await new Promise((r) => setTimeout(r, 1500));

  check("sair da sessão MANTÉM o processo vivo (sessão em segundo plano)", markerAlive(), true);
  const xtermOnHome = await page.evalJs(`document.querySelectorAll('.xterm').length`);
  check("na Home não há xterm montado (UI do board desmontada: zero render)", xtermOnHome, 0);

  const bg = await page
    .evalJs(`(async () => JSON.stringify(await window.store.boardBackgroundStatus()))()`)
    .then(JSON.parse);
  check("o board aparece como vivo no estado de fundo", bg.boards?.[boardId]?.alive, true);
  check("...e conta como uma sessão de fundo", bg.backgroundCount >= 1, true);

  // --- EXPLICIT "stop session": kills, and proves the signal ladder ---
  await page.evalJs(`window.store.boardStop(${JSON.stringify(boardId)})`);
  check("parar sessão encerra mesmo um processo que ignora HUP e TERM", await waitFor(() => !markerAlive(), 12_000), true);

  // --- scope: on Home there is no operable card ---
  const onHome = await toolJson("list_cards", {});
  check("na Home o list_cards fica vazio (nenhum card montado pra operar)", onHome.cards.length, 0);

  // --- new session: only its own cards ---
  await bootIntoFreshSession(page, "Sessao B");
  await new Promise((r) => setTimeout(r, 1500));
  const onB = await toolJson("list_cards", {});
  check("depois de trocar, o list_cards traz só a sessão aberta", onB.cards.every((c) => c.id !== bashA), true);
  check("...e ela tem o próprio terminal", onB.cards.some((c) => c.kind === "terminal"), true);
} finally {
  finish();
  await stopApp(app);
  await new Promise((r) => setTimeout(r, 600));
  if (markerAlive()) {
    console.error("AVISO: o processo marcado sobreviveu até o fim do teste — limpando");
    try {
      execSync(`pkill -9 -f '[${MARKER[0]}]${MARKER.slice(1)}'`);
    } catch {
      /* nothing to do */
    }
  }
}
