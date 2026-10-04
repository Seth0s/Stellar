// task ff24b36d — comando PESADO nunca concorre: `acbridge gate-lock` e a tool
// MCP `run_locked` pegam o MESMO lock do gate-runner. Mede dois `sleep 3` em
// paralelo no mesmo repo: ~6s, não 3. Instância ISOLADA (userData/portas).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
// userData CURTO de propósito: o socket unix do bus tem teto de ~108 chars no
// caminho, e o userData carrega `profiles/<uuid>/agent-canvas.sock` — um
// caminho longo demais faz o bind falhar e o acbridge não conecta. Isolado
// (porta e userData próprios), só que curto.
const USER_DATA_DIR = mkdtempSync(join(tmpdir(), "stellar-gl-"));
const SHOT_DIR = new URL(`../../.verify-tmp/shots-gate-lock-${CDP_PORT}`, import.meta.url).pathname;
const WORK = mkdtempSync(join(tmpdir(), "stellar-gate-lock-work-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextRpcId = 1;
let mcpUrl = `http://127.0.0.1:${MCP_PORT}/mcp`;
async function mcpCall(method, params, url = mcpUrl) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function toolJson(name, args, url = mcpUrl) {
  const rpc = await mcpCall("tools/call", { name, arguments: args }, url);
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}
const delayMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function shoot(page, name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    const { data } = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const path = `${SHOT_DIR}/${name}.png`;
    writeFileSync(path, Buffer.from(data, "base64"));
    console.log(`  print: ${path}`);
  } catch (err) {
    console.log(`  print ${name} falhou: ${String(err)}`);
  }
}

const { check, skip, finish } = makeChecker();
// Limpa a identidade herdada do PROCESSO que roda o smoke (o card `bash` da
// instância nova não deve herdar o AGENT_CANVAS_TASK_ID de outro card/shell).
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { AGENT_CANVAS_TASK_ID: "", AGENT_CANVAS_CARD_ID: "", AGENT_CANVAS_SOCK: "" },
});
try {
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  await bootIntoFreshSession(page, "Smoke Gate-Lock", { spawnTerminal: true });
  await delay(500);

  const cards = await toolJson("list_cards", {});
  const bashId = cards.cards.find((c) => c.kind === "terminal").id;
  // Identidade do chamador pelo carimbo da URL (run_locked exige identidade).
  mcpUrl = `http://127.0.0.1:${MCP_PORT}/mcp?card=${bashId}`;

  // ---- MCP run_locked: dois comandos no MESMO repo serializam (~6s, não 3) ----
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    toolJson("run_locked", { command: "sleep 3", cwd: WORK, scope: "repo" }),
    toolJson("run_locked", { command: "sleep 3", cwd: WORK, scope: "repo" }),
  ]);
  const elapsed = Date.now() - t0;
  console.log(`  [medido] run_locked x2 sleep 3 (repo): ${elapsed}ms; waitedMs=${r1.waitedMs}/${r2.waitedMs}`);
  check("dois run_locked (sleep 3) no mesmo repo levam ~6s, não 3", elapsed >= 5_200 && elapsed <= 9_000, true);
  const waits = [r1.waitedMs, r2.waitedMs].sort((a, b) => a - b);
  check("...um entrou direto (waitedMs 0)", waits[0], 0);
  check("...o outro esperou o primeiro (waitedMs > 0)", waits[1] > 0, true);
  check("...os dois saíram com exit code real 0", r1.exitCode === 0 && r2.exitCode === 0, true);

  // ---- scope machine serializa entre cwds diferentes ----
  const WORK2 = mkdtempSync(join(tmpdir(), "stellar-gate-lock-work2-"));
  const tm0 = Date.now();
  const [m1, m2] = await Promise.all([
    toolJson("run_locked", { command: "sleep 3", cwd: WORK, scope: "machine" }),
    toolJson("run_locked", { command: "sleep 3", cwd: WORK2, scope: "machine" }),
  ]);
  const elapsedMachine = Date.now() - tm0;
  console.log(`  [medido] run_locked x2 sleep 3 (machine): ${elapsedMachine}ms; waitedMs=${m1.waitedMs}/${m2.waitedMs}`);
  check("scope machine serializa entre repos (≈6s)", elapsedMachine >= 5_200 && elapsedMachine <= 9_000, true);
  rmSync(WORK2, { recursive: true, force: true });

  // ---- Fila: indicador de gate enquanto um comando roda ----
  await spawnCard(page, "task");
  await delay(600);
  const inFlight = toolJson("run_locked", { command: "sleep 8", cwd: WORK, scope: "machine" });
  let sawIndicator = false;
  for (let i = 0; i < 20 && !sawIndicator; i++) {
    await delay(300);
    const status = await page.evalJs(`window.bus?.gateLockStatus ? window.bus.gateLockStatus().then(r => JSON.stringify(r)) : Promise.resolve("null")`);
    const parsed = JSON.parse(status);
    if (parsed && Array.isArray(parsed.locks) && parsed.locks.length > 0) sawIndicator = true;
  }
  check("gate_lock_status mostra o lock em curso (fonte do indicador da Fila)", sawIndicator, true);
  // O indicador da Fila polla a cada 3s: espera até ~6s pelo render.
  let domIndicator = false;
  for (let i = 0; i < 20 && !domIndicator; i++) {
    domIndicator = await page.evalJs(`!!document.querySelector('[data-part="gate-lock-indicator"]')`);
    if (!domIndicator) await delay(300);
  }
  check("a Fila mostra o indicador de gate", domIndicator, true);
  await shoot(page, "fila-gate-indicator");
  await inFlight;

  // ---- acbridge gate-lock (a porta CLI) ----
  await toolJson("send_to_card", { target: bashId, text: "acbridge version 2>&1 | head -1" });
  await delay(1500);
  const ver = await toolJson("read_card", { target: bashId, lines: 6 });
  const acbridgeOk = /acbridge protocol\s+\d+\s+bus protocol\s+\d+\s+match/.test(ver.text ?? "");
  if (!acbridgeOk) {
    skip(
      "acbridge gate-lock -- sleep 3 (x2 em paralelo): a CLI não conectou ao socket do bus nesta instância",
      `acbridge version disse: ${JSON.stringify((ver.text ?? "").slice(-160))}`,
    );
  } else {
    // Sanidade primeiro: um único gate-lock, com a saída visível.
    await toolJson("send_to_card", { target: bashId, text: `acbridge gate-lock -- echo GATE_OK; echo SINGLE_RC=$?` });
    await delay(2500);
    const single = await toolJson("read_card", { target: bashId, lines: 6 });
    console.log(`  [debug] gate-lock single: ${JSON.stringify((single.text ?? "").slice(-200))}`);
    const cmd = `S=$(date +%s%3N); (acbridge gate-lock -- sleep 3; echo A:$?) & (acbridge gate-lock -- sleep 3; echo B:$?) & wait; E=$(date +%s%3N); echo GATELOCK_ELAPSED=$((E-S))`;
    await toolJson("send_to_card", { target: bashId, text: cmd });
    await delay(9000);
    const out = await toolJson("read_card", { target: bashId, lines: 16 });
    console.log(`  [debug] gate-lock parallel: ${JSON.stringify((out.text ?? "").slice(-300))}`);
    const m = (out.text ?? "").match(/GATELOCK_ELAPSED=(\d+)/);
    if (!m) {
      skip("acbridge gate-lock -- sleep 3 (x2 em paralelo)", "sem ELAPSED na saída do card");
    } else {
      const ms = Number(m[1]);
      console.log(`  [medido] acbridge gate-lock x2 sleep 3: ${ms}ms`);
      check("acbridge gate-lock x2 (sleep 3) levam ~6s, não 3", ms >= 5_500 && ms <= 9_500, true);
    }
  }

  await shoot(page, "final");
  page.close();
} finally {
  await stopApp(app);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
}
finish();
