// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 6 — same
// architectural boundary as peças 4/5 (explicit user decision): this app
// doesn't queue excess spawns or auto-kill anything on timeout.
// `concurrency_status` is purely advisory — a real count of currently
// running non-bash agent cards against a cap, for an external
// orchestrator to check itself before deciding whether to call
// spawn_agent again.
//
// Real cards, real processes: spawns actual "claude" cards (installed on
// this machine, same provider other smoke tests already use) and kills
// one for real, rather than asserting against a canned number.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-mcp-concurrency-${CDP_PORT}`, import.meta.url).pathname;

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

async function spawnClaude(page, requesterId) {
  const spawnPromise = callTool("spawn_agent", { provider: "claude", callerCardId: requesterId, reason: "smoke test peça 6" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const payload = JSON.parse((await spawnPromise).content[0].text);
  await new Promise((r) => setTimeout(r, 400));
  return payload.cardId;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await new Promise((r) => setTimeout(r, 1000));
  await bootIntoFreshSession(page, "MCP Concurrency Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  const initial = await toolJson("concurrency_status", {});
  check("logo no boot (só o bash seedado, que não conta como agente), running é 0 com o cap default (3)", JSON.stringify(initial), JSON.stringify({ ok: true, running: 0, cap: 3, atCap: false }));

  const claudeIds = [];
  for (let i = 0; i < 3; i++) {
    claudeIds.push(await spawnClaude(page, bashCardId));
    const status = await toolJson("concurrency_status", {});
    check(`depois de spawnar o agente real #${i + 1}, running é ${i + 1}`, status.running, i + 1);
    check(`...atCap é ${i + 1 >= 3}`, status.atCap, i + 1 >= 3);
  }

  // Mata um processo real — o número tem que refletir isso de verdade,
  // não ficar preso no pico anterior.
  await page.evalJs(`window.pty.kill(${JSON.stringify(claudeIds[0])})`);
  await new Promise((r) => setTimeout(r, 600));
  const afterKill = await toolJson("concurrency_status", {});
  check("depois de matar um processo real, running volta pra 2 (sinal real, não travado no pico)", afterKill.running, 2);
  check("...e atCap volta a false", afterKill.atCap, false);

  // Cap customizado, passado pelo chamador — puramente consultivo, não
  // muda nada no comportamento real de spawn.
  const customCap = await toolJson("concurrency_status", { cap: 1 });
  check("com um cap customizado (1), atCap reflete esse cap, não o default", customCap.atCap, true);
  check("...cap ecoado de volta é o que foi passado", customCap.cap, 1);

  page.close();
} finally {
  await stopApp(app);
}
finish();
