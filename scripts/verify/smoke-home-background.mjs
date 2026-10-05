// End-to-end MEASUREMENT.
//
// Two sessions, each with a long-lived process that ignores HUP/TERM. Measures:
//   - leaving the sessions keeps both processes alive (background sessions);
//   - Home renders the running indicator on each session card;
//   - "Stop session" (the card action) kills ONLY that session's processes and
//     the indicator disappears.
//
// Isolated instance (own userData and port); never touches the owner's app.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-home-background-${CDP_PORT}`, import.meta.url).pathname;
const MARK_PREFIX = "STELLAR_HOMEBG_";

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
async function goHome(page) {
  const home = await page.evalJs(`!!document.querySelector('.home')`);
  if (home) return;
  const c = JSON.parse(
    await page.evalJs(
      `(() => { const el = document.querySelector('.topbar-home'); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`,
    ),
  );
  await page.click(c.x, c.y);
  await delay(1200);
}
async function cardIdForBoard(page, boardId) {
  return await page.evalJs(
    `(async () => (await window.store.list(${JSON.stringify(boardId)})).find((c) => c.kind === 'terminal')?.id ?? null)()`,
  );
}
async function boardIdByName(page, name) {
  return await page.evalJs(
    `(async () => (await window.store.boards.list()).find((b) => b.name === ${JSON.stringify(name)})?.id ?? null)()`,
  );
}
async function indicatorCount(page) {
  return await page.evalJs(`document.querySelectorAll('.home-session-background').length`);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);

  const sessions = [
    { name: "HomeBG Sessao 1", marker: `${MARK_PREFIX}1` },
    { name: "HomeBG Sessao 2", marker: `${MARK_PREFIX}2` },
  ];

  for (const s of sessions) {
    await goHome(page);
    await bootIntoFreshSession(page, s.name);
    await delay(700);
    s.boardId = await boardIdByName(page, s.name);
    s.cardId = await cardIdForBoard(page, s.boardId);
    // Prints a line, then becomes a process that ignores HUP/TERM.
    const cmd = `echo READY_${s.marker}; exec sh -c 'trap "" HUP TERM; while true; do sleep 1; done' ${s.marker}`;
    await toolJson("send_to_card", { target: s.cardId, text: cmd });
  }
  await delay(1500);
  check("2 processos de sessão rodando", markerCount(), 2);

  // --- leave for Home: processes keep running, the cards show the indicator ---
  await goHome(page);
  await delay(1200);
  check("sair das sessões NÃO encerra os processos", markerCount(), 2);
  check("a Home mostra o indicador em cada sessão viva", await indicatorCount(page), 2);

  const bg = JSON.parse(await page.evalJs(`(async () => JSON.stringify(await window.store.boardBackgroundStatus()))()`));
  check("as 2 sessões aparecem vivas no estado de fundo", bg.backgroundCount, 2);

  // Screenshot of the Home with the two running indicators, for the report.
  try {
    await page.send("Page.enable");
    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    const dir = process.env.COMMANDCODE_SCRATCHPAD ?? new URL("../../.verify-tmp", import.meta.url).pathname;
    writeFileSync(`${dir}/home-background.png`, Buffer.from(shot.data, "base64"));
    console.log(`[shot] ${dir}/home-background.png`);
  } catch (e) {
    console.log(`[shot] failed: ${String(e)}`);
  }

  // --- stop ONLY session 1 through the card action ---
  const clicked = await page.evalJs(`
    (() => {
      const cards = [...document.querySelectorAll('.home-session-card')];
      const card = cards.find((c) => c.textContent.includes(${JSON.stringify(sessions[0].name)}));
      const stop = card?.querySelector('[data-role="stop-session"]');
      if (!stop) return false;
      stop.click();
      return true;
    })()
  `);
  check("o card da sessão tem a ação 'Parar sessão'", clicked, true);
  const deadline = Date.now() + 12_000;
  let after = 2;
  while (Date.now() < deadline) {
    after = markerCount();
    if (after === 1) break;
    await delay(300);
  }
  check("parar a sessão 1 mata só o processo dela (1 restante)", after, 1);
  // The indicator clears once the background projection re-reads (a round trip).
  const indDeadline = Date.now() + 6000;
  while (Date.now() < indDeadline) {
    if ((await indicatorCount(page)) === 1) break;
    await delay(200);
  }
  check("o indicador da sessão parada desaparece", await indicatorCount(page), 1);

  // --- stop the second one too ---
  await page.evalJs(`window.store.boardStop(${JSON.stringify(sessions[1].boardId)})`);
  const deadline2 = Date.now() + 12_000;
  while (Date.now() < deadline2 && markerCount() > 0) await delay(300);
  check("parar a sessão 2 mata o processo restante", markerCount(), 0);
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
