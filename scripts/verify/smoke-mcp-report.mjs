// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 1 — before
// this, the only way to check a spawned agent's result was reading raw
// scrollback (ANSI, spinners, tool-call noise) and guessing which part
// was the actual answer. `report`/`read_report` is a dedicated push
// channel: the agent calls `acbridge report '<json>'` when it finishes,
// the caller reads a structured value back, no scrollback parsing.
//
// Real process, real acbridge binary, real Unix socket round-trip — the
// spawned card runs `acbridge report ...` as an actual shell command,
// not a shortcut through some internal function.
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = 9502;
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL("../../.verify-tmp/smoke-mcp-report", import.meta.url).pathname;

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
  await bootIntoFreshSession(page, "MCP Report Teste");
  await new Promise((r) => setTimeout(r, 500));

  const listPayload = await toolJson("list_cards", {});
  const bashCardId = listPayload.cards[0].id;

  // Ler o report antes de qualquer coisa ter sido reportada — erro
  // honesto, sem wait, sem travar.
  const beforeReport = await toolJson("read_report", { target: bashCardId });
  check("read_report antes de qualquer report reporta ok:false", beforeReport.ok, false);

  // Spawna um segundo bash real (o "agente delegado").
  const spawnPromise = callTool("spawn_agent", { provider: "bash", callerCardId: bashCardId, reason: "smoke test peça 1" });
  await new Promise((r) => setTimeout(r, 500));
  await clickModalButton(page, "Permitir");
  const spawnPayload = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent resolve ok com um cardId real", spawnPayload.ok && typeof spawnPayload.cardId === "string", true);
  const workerCardId = spawnPayload.cardId;
  await new Promise((r) => setTimeout(r, 800));

  // read_report com wait:true — ANTES do worker reportar, pra provar que
  // é um wait real (resolve só quando o report chegar), não um retorno
  // imediato coincidente.
  const waitPromise = callTool("read_report", { target: workerCardId, wait: true, timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 500));

  // O "agente" real chama `acbridge report` de verdade, como um shell
  // command genuíno — não um atalho interno.
  const reportJson = JSON.stringify({ ok: true, result: "tarefa-concluida-42931" }).replace(/"/g, '\\"');
  await page.evalJs(`window.pty.write(${JSON.stringify(workerCardId)}, ${JSON.stringify(`acbridge report "${reportJson}"\r`)})`);

  const start = Date.now();
  const waitResult = JSON.parse((await waitPromise).content[0].text);
  const elapsedMs = Date.now() - start;

  check("read_report(wait:true) resolve ok depois do acbridge report real", waitResult.ok, true);
  check("...com o resultado estruturado exato reportado (sem parsing de scrollback)", JSON.stringify(waitResult.report), JSON.stringify({ ok: true, result: "tarefa-concluida-42931" }));
  check("...resolveu rápido pelo push real, não pelos 15s do waitTimeoutMs", elapsedMs < 10000, true);

  // Um segundo read_report (sem wait) depois do fato — o último report
  // fica disponível pra quem chega depois.
  const afterReport = await toolJson("read_report", { target: workerCardId });
  check("read_report sem wait, depois do fato, ainda devolve o último report", JSON.stringify(afterReport), JSON.stringify({ ok: true, report: { ok: true, result: "tarefa-concluida-42931" } }));

  page.close();
} finally {
  await stopApp(app);
}
finish();
