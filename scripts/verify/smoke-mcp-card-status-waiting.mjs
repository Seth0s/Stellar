// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 2 — a card
// blocked on its own consent modal (open_url/spawn_agent/spawn_card,
// waiting on a human to click Permitir/Negar) used to be indistinguishable
// from one still working: card_status only knew running/exited. This is
// "causa nº 1 de orquestração que trava sem ninguém perceber" per the
// audit — an orchestrator polling card_status would see "running" and
// keep waiting forever on an agent that's actually stuck on a dialog no
// one's looking at.
//
// Opens a REAL consent gate (open_url) and leaves it open on purpose —
// the whole point is checking status WHILE it's still pending, not after.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9509;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-card-status-waiting", import.meta.url).pathname;

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
  return JSON.parse(jsonLine);
}
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  const result = await callTool(name, args);
  return JSON.parse(result.content[0].text);
}

async function clickModalButton(page, label) {
  const coords = JSON.parse(
    await page.evalJs(`
      (() => {
        const b = [...document.querySelectorAll('.modal-actions button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return JSON.stringify(null);
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      })()
    `),
  );
  if (!coords) throw new Error(`no modal button labeled "${label}"`);
  await page.click(coords.x, coords.y);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "MCP Card Status Waiting Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  const bashCardId = listPayload.cards[0].id;

  const beforeStatus = await toolJson("card_status", { target: bashCardId });
  check("antes de qualquer gate, o card está 'running'", JSON.stringify(beforeStatus), JSON.stringify({ ok: true, status: "running" }));

  // Abre um gate de consentimento real (open_url) e deixa pendurado de
  // propósito — o teste é exatamente sobre o status ENQUANTO ninguém
  // decidiu ainda.
  const openPromise = callTool("open_url", { url: "https://example.com", callerCardId: bashCardId, reason: "smoke test peça 2" });
  await new Promise((r) => setTimeout(r, 600));

  const whileWaitingStatus = await toolJson("card_status", { target: bashCardId });
  check(
    "com o modal de consentimento real ainda aberto, card_status reporta 'waiting' — não 'running'",
    JSON.stringify(whileWaitingStatus),
    JSON.stringify({ ok: true, status: "waiting" }),
  );

  // Resolve o gate — status volta a refletir o processo real (ainda vivo).
  await clickModalButton(page, "Permitir");
  await openPromise;
  await new Promise((r) => setTimeout(r, 300));
  const afterResolvedStatus = await toolJson("card_status", { target: bashCardId });
  check("depois do humano decidir, card_status volta a 'running'", JSON.stringify(afterResolvedStatus), JSON.stringify({ ok: true, status: "running" }));

  // E o terceiro estado real continua funcionando (M4) — não regrediu.
  await page.evalJs(`window.pty.kill(${JSON.stringify(bashCardId)})`);
  await new Promise((r) => setTimeout(r, 500));
  const exitedStatus = await toolJson("card_status", { target: bashCardId });
  check("e 'exited' continua funcionando pro terceiro estado", JSON.stringify(exitedStatus), JSON.stringify({ ok: true, status: "exited" }));

  page.close();
} finally {
  await stopApp(app);
}
finish();
