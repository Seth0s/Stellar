// INVESTIGAÇÃO (task 71128571) — depois de ligar o modo autônomo pelo
// caminho real, `smoke-mcp-autonomous-mode` reprovou em "spawn autônomo #1
// resolve ok:true sem modal (got false)" / "...nenhum modal apareceu (got
// true)". Duas leituras possíveis, com consertos opostos:
//   (a) o auto-approve do app regrediu (APP-REGRESSAO → parar e reportar);
//   (b) sobrou um modal na tela (o das configurações, que o caminho novo
//       abre e fecha) e o `!!document.querySelector('.modal')` do smoke
//       passou a medir ESSE modal, não o de consentimento.
// Este script mede qual dos dois: dump de QUANTOS `.modal` existem e o texto
// de cada um, em cada passo (antes de ligar, depois de ligar, depois do
// spawn_agent).
import { startApp, stopApp, connectPage, bootIntoFreshSession, pickFreePort, enableAutonomousMode } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/investigate-autonomous-modal-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextRpcId = 1;
async function mcpCall(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
  const text = await res.text();
  const jsonLine = text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? text;
  return JSON.parse(jsonLine);
}
async function toolJson(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return JSON.parse(rpc.result.content[0].text);
}

async function modals(page) {
  return JSON.parse(
    await page.evalJs(`
      JSON.stringify([...document.querySelectorAll('.modal')].map((m) => ({
        cls: m.className,
        role: m.getAttribute('role') ?? null,
        text: (m.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      })))
    `),
  );
}

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Investigate Autonomous");
  await delay(500);

  const bashCardId = JSON.parse(
    await page.evalJs(`
      (async () => {
        const boards = await window.store.boards.list();
        const cards = await window.store.list(boards[0].id);
        return JSON.stringify(cards.find((c) => c.kind === 'terminal' && c.provider === 'bash').id);
      })()
    `),
  );
  console.log(`bashCardId=${bashCardId}`);
  console.log(`1) antes de ligar: modais=${JSON.stringify(await modals(page))}`);
  console.log(`   board_mode=${JSON.stringify(await toolJson("board_mode", { target: bashCardId }))}`);

  await enableAutonomousMode(page);
  console.log(`2) depois de ligar: modais=${JSON.stringify(await modals(page))}`);
  console.log(`   board_mode=${JSON.stringify(await toolJson("board_mode", { target: bashCardId }))}`);
  console.log(
    `   badge do topbar=${JSON.stringify(await page.evalJs(`document.querySelector('.topbar-autonomous-badge')?.textContent ?? null`))}`,
  );

  const spawn = await toolJson("spawn_agent", { provider: "bash", callerCardId: bashCardId, reason: "investigação: o modal é do consentimento?" });
  await delay(500);
  console.log(`3) spawn_agent => ${JSON.stringify(spawn)}`);
  console.log(`   modais agora=${JSON.stringify(await modals(page))}`);
  console.log(`   board_mode=${JSON.stringify(await toolJson("board_mode", { target: bashCardId }))}`);

  page.close();
} finally {
  await stopApp(app);
}
