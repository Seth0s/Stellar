// Pedido ao vivo (2026-09-06) — "pros providers sem hook oficial, por
// enquanto desativa as notificações, e melhore o sistema atual com lógica:
// no codex sempre acaba um turno quando aparece 'Worked for 1m 06s'".
// Esse marcador virou DECLARAÇÃO (task 0dd5c145): `providers.ts`'s
// `capacity.delivery.turnEnd` do codex carrega este padrão, a projeção do
// canal de disponibilidade o entrega ao renderer e `useTerminal.ts` o aplica —
// mesmo bypass do relógio de 900ms de silêncio que o `claude` já tinha pelo
// hook `Stop`, só que vindo de TEXTO renderizado em vez de um evento (o codex
// não tem hook para "o turno do agente principal acabou" — confirmado
// investigando o binário).
//
// Can't drive a real `codex` turn here (costs real API tokens, needs auth) —
// this swaps in a tiny fake `codex` executable (a bash script, no real CLI
// involved) ahead of the real one on PATH, so `providers.ts`'s `which()`
// resolves to OUR script. It reproduces the exact shape of the bug being
// fixed: prints something, then goes SILENT for well over 900ms (still
// "thinking"), then finally prints the real marker line. Proves two things
// the pattern-match approach exists for: isActive survives the long silent
// gap (the old 900ms timer would have wrongly gone idle there), and only
// flips false once the actual marker text appears — not before, not via a
// blind timeout.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-turn-end-pattern-${CDP_PORT}`, import.meta.url).pathname;
const FAKE_BIN_DIR = new URL(`../../.verify-tmp/fake-codex-bin-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(FAKE_BIN_DIR, { recursive: true });
writeFileSync(
  `${FAKE_BIN_DIR}/codex`,
  `#!/bin/bash\necho "pensando..."\nsleep 2.5\necho "Worked for 1m 06s"\nsleep 30\n`,
);
chmodSync(`${FAKE_BIN_DIR}/codex`, 0o755);

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
async function isCardActive(page, cardId) {
  return JSON.parse(
    await page.evalJs(
      `JSON.stringify(document.querySelector('[data-role="terminal-activity"][data-card-id=${JSON.stringify(cardId)}]')?.dataset.active === "true")`,
    ),
  );
}

const { check, finish } = makeChecker();
const app = await startApp({
  cdpPort: CDP_PORT,
  userDataDir: USER_DATA_DIR,
  extraEnv: { PATH: `${FAKE_BIN_DIR}:${process.env.PATH ?? ""}` },
});
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);

  // Mock ANTES do boot — smoke-terminal-focus-notification.mjs's mesma
  // técnica: window.Notification real dispararia um toast de SO de
  // verdade, sem jeito de observar via DOM/CDP.
  await page.evalJs(`
    window.__notificationCalls = [];
    window.Notification = class {
      constructor(title, options) {
        window.__notificationCalls.push({ title, options });
      }
    };
  `);

  await bootIntoFreshSession(page, "Turn End Pattern Smoke");
  await delay(500);

  const spawnPromise = callTool("spawn_agent", { provider: "codex", reason: "smoke turn-end pattern" });
  await delay(500);
  await clickModalButton(page, "Permitir");
  const spawnResult = JSON.parse((await spawnPromise).content[0].text);
  check("spawn_agent(codex, fake shim) resolve ok com um cardId real", typeof spawnResult.cardId, "string");
  const codexCardId = spawnResult.cardId;

  await delay(600);
  check("isActive vira true assim que o fake shim imprime a 1ª linha", await isCardActive(page, codexCardId), true);

  await delay(1500);
  check(
    "isActive continua true depois de >900ms de silêncio (o bug que o 900ms puro tinha pro claude não se repete pro codex)",
    await isCardActive(page, codexCardId),
    true,
  );

  await delay(1500);
  check("isActive vira false só depois do marcador 'Worked for ...' aparecer de verdade", await isCardActive(page, codexCardId), false);

  check(
    "nenhuma notificação de SO disparada (codex não tem hook oficial, notificação fica desligada por enquanto)",
    await page.evalJs(`JSON.stringify(window.__notificationCalls)`),
    "[]",
  );
} finally {
  finish();
  await stopApp(app);
}
