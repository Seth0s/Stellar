// Prototipo (2026-09-06) — "barra de status em running some" +
// "unificar detecção de turno" (pedidos do usuário). Hoje `isActive`
// (useTerminal.ts) é só uma aproximação por silêncio de bytes (900ms sem
// nada = "parou") — a barra de atividade some mesmo com o agente
// genuinamente ainda trabalhando (pensando, chamando ferramenta). Fix
// prototipado só pro provider `claude`: um hook `Stop` real (--settings
// efêmero, providers.ts) chama `acbridge turn-complete` no fim de
// verdade do turno; `useTerminal.ts` usa isso pra desligar `isActive` em
// vez do timer de silêncio.
//
// Este teste não depende do timing real de um turno de `claude`
// "pensando" (imprevisível) — em vez disso conecta DIRETO no mesmo
// socket Unix que o `acbridge` real usa (mesmo protocolo, mesmo cmd
// `turn_complete`) pra simular o hook determinísticamente:
//   1. Card `bash` — prova a plumbing (dispatch → main → renderer)
//      funciona de ponta a ponta, sem depender de provider nenhum.
//   2. Card `claude` — prova o GATING específico: depois de 900ms+ sem
//      nenhum byte novo, a barra CONTINUA "ligada" (o timer de silêncio
//      foi dispensado de propósito) até o sinal real chegar.
import net from "node:net";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, clickProviderInPicker, openTerminalCreatePopover } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-terminal-turn-complete-${CDP_PORT}`, import.meta.url).pathname;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function toolJson(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

// Mesmo protocolo cru que `resources/bin/acbridge` usa — uma linha JSON,
// meia-conexão de escrita, lê a resposta e fecha. Simula exatamente o que
// o hook Stop dispara, sem precisar de um turno de verdade completar.
function sendTurnComplete(sockPath, cardId) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: sockPath }, () => {
      socket.end(JSON.stringify({ cmd: "turn_complete", cardId }) + "\n");
    });
    let out = "";
    socket.on("data", (c) => (out += c));
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}

async function isActiveFor(page, cardId) {
  return page.evalJs(
    `document.querySelector(\`[data-role="terminal-activity"][data-card-id="${cardId}"][data-active="true"]\`) !== null`,
  );
}

async function centerOf(page, selector) {
  let res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  if (!res && selector.includes(".rail-btn[title=")) {
    const titleMatch = selector.match(/title=["']([^"']+)["']/);
    if (titleMatch) {
      const title = titleMatch[1];
      const addBtn = JSON.parse(
        await page.evalJs(`
          (() => {
            const b = document.querySelector('.rail-btn[title="Adicionar card"]');
            if (!b) return JSON.stringify(null);
            const r = b.getBoundingClientRect();
            return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
          })()
        `),
      );
      if (addBtn) {
        await page.click(addBtn.x, addBtn.y);
        await delay(250);
        res = JSON.parse(
          await page.evalJs(`
            (() => {
              const el = document.querySelector(\`.popover-row[title="${title}"]\`);
              if (!el) return JSON.stringify(null);
              const r = el.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
            })()
          `),
        );
      }
    }
  }
  return res;
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Turn Complete Teste");
  await delay(800);

  const sockPath = join(USER_DATA_DIR, "agent-canvas.sock");

  // ---- CASO 1: bash — prova a plumbing sem depender de provider nenhum ----
  const bashId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'bash').id);
      })()
    `),
  );

  await page.evalJs(`window.pty.write(${JSON.stringify(bashId)}, ${JSON.stringify("echo caso1\\n")})`);
  await delay(300);
  check("CASO 1 (bash): isActive true logo após escrever", await isActiveFor(page, bashId), true);

  await sendTurnComplete(sockPath, bashId);
  await delay(200);
  check(
    "CASO 1 (bash): turn_complete via socket desliga isActive quase na hora (bem antes dos 900ms do timer)",
    await isActiveFor(page, bashId),
    false,
  );

  // ---- CASO 2: claude — prova que o timer de 900ms é dispensado ----
  await openTerminalCreatePopover(page);
  // O provider é escolhido pelo RÓTULO declarado, resolvido do próprio app:
  // o `[title="claude"]` que estava aqui nunca casou (o `title` do botão é o
  // rótulo + as flags, desde a c857539c).
  await clickProviderInPicker(page, "claude");
  await delay(200);
  const criarBtn = await centerOf(page, ".popover-actions button.primary");
  await page.click(criarBtn.x, criarBtn.y);
  await delay(1500);

  const claudeId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'claude').id);
      })()
    `),
  );
  check("card claude real criado", typeof claudeId === "string", true);

  // Espera o spawn imprimir alguma coisa (prompt inicial) — já deixa
  // isActive true de graça, sem precisar escrever nada.
  await delay(1500);
  check("CASO 2 (claude): isActive true logo após o spawn imprimir algo", await isActiveFor(page, claudeId), true);

  // Passa BEM dos 900ms do timer de silêncio antigo, sem nenhum turn_complete —
  // se o gating estiver certo, isActive continua true (não foi dispensado
  // pelo timer, que nem deveria estar rodando pra este provider).
  await delay(1400);
  check(
    "CASO 2 (claude): isActive CONTINUA true bem depois dos 900ms (timer de silêncio dispensado pra este provider)",
    await isActiveFor(page, claudeId),
    true,
  );

  await sendTurnComplete(sockPath, claudeId);
  await delay(200);
  check(
    "CASO 2 (claude): turn_complete via socket desliga isActive (sinal real de fim de turno)",
    await isActiveFor(page, claudeId),
    false,
  );

  page.close();
} finally {
  await stopApp(app);
}
finish();
