// DESIGN-BACKLOG.md item 58, M4 — no signal existed for "did the agent I
// spawned finish yet" beyond visual `snapshot` polling. Adds `card_status`
// (running/exited) and `spawn_agent`'s `wait: true`, which holds the MCP
// call open until the spawned card's process actually exits.
//
// No visual snapshot polling anywhere in this test, by design — that's
// exactly the thing being replaced.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9495;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-card-status", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "MCP Card Status Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  // `.find(kind === "terminal")` em vez de `[0]` (2026-09-01): `list_cards`
  // devolve TODOS os cards vivos agora, não só terminais, então a primeira
  // posição da lista deixou de ser garantidamente o bash seedado.
  const bashCardId = listPayload.cards.find((c) => c.kind === "terminal").id;

  // card_status contra o card bash já vivo, seedado pelo boot.
  const runningStatus = await toolJson("card_status", { target: bashCardId });
  check("card_status reporta 'running' pra um card vivo", JSON.stringify(runningStatus), JSON.stringify({ ok: true, status: "running" }));

  // card_status num id inexistente — erro honesto.
  const missingStatus = await toolJson("card_status", { target: "nao-existe-777" });
  check("card_status num card inexistente reporta ok:false", missingStatus.ok, false);

  // Mata o processo do card bash direto (window.pty.kill) e confirma que
  // card_status muda pra 'exited' — sem nenhum snapshot no caminho.
  await page.evalJs(`window.pty.kill(${JSON.stringify(bashCardId)})`);
  await new Promise((r) => setTimeout(r, 800));
  const exitedStatus = await toolJson("card_status", { target: bashCardId });
  check("card_status reflete 'exited' depois do processo real morrer", JSON.stringify(exitedStatus), JSON.stringify({ ok: true, status: "exited" }));

  // spawn_agent com wait:true — spawna um segundo bash real, mata o
  // processo ANTES do wait window (waitTimeoutMs curto só pra este
  // teste), confirma que a chamada MCP resolve com exited:true e um
  // exitCode real assim que o processo morre, não por timeout.
  const spawnPromise = callTool("spawn_agent", {
    provider: "bash",
    callerCardId: bashCardId,
    reason: "smoke test M4",
    wait: true,
    waitTimeoutMs: 15000,
  });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  await new Promise((r) => setTimeout(r, 500));

  const newCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'bash' && c.id !== ${JSON.stringify(bashCardId)})?.id ?? null);
      })()
    `),
  );
  check("um segundo card bash real foi criado pelo spawn_agent(wait:true)", newCardId !== null, true);

  const start = Date.now();
  await page.evalJs(`window.pty.kill(${JSON.stringify(newCardId)})`);
  const spawnResult = JSON.parse((await spawnPromise).content[0].text);
  const elapsedMs = Date.now() - start;

  check("spawn_agent(wait:true) resolve ok depois do processo morrer", spawnResult.ok, true);
  check("...com exited:true", spawnResult.exited, true);
  check("...e um exitCode real (número)", typeof spawnResult.exitCode, "number");
  check("...resolveu rápido (sinal real de exit), não esperou o waitTimeoutMs de 15s inteiro", elapsedMs < 10000, true);

  page.close();
} finally {
  await stopApp(app);
}
finish();
