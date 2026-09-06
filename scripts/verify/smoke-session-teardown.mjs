// Achado ao vivo (2026-09-01): "se eu trocar de sessão os terminais e
// serviços não são fechados daquela sessão".
//
// A sonda mostrou que o unmount do card JÁ chamava kill e que um `bash`
// morria na hora — o que escondia o defeito real: `kill` mandava um
// `SIGHUP` (o default do node-pty) e apagava a entrada do registry na
// MESMA linha, sem nunca confirmar a morte. Um processo que ignora ou
// demora no SIGHUP virava órfão, e como a entrada já tinha sumido,
// `isAlive`/`card_status` passavam a responder "exited" com o processo
// vivo — a app perdia até a capacidade de saber que ele existia.
//
// Um shell propaga SIGHUP e some, e é por isso que o caminho mais testado
// parecia certo. CLIs de agente são justamente as que instalam handler de
// sinal pra desligar com calma, ou seja, exatamente as que sobreviviam.
//
// O teste abaixo reproduz isso sem depender de nenhuma CLI real: um
// `exec` faz o processo do PTY VIRAR um shell que ignora HUP e TERM, então
// só o último degrau da escada (SIGKILL) o encerra. Se o escalonamento
// regredir pra um sinal só, este arquivo fica vermelho.
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
/** `pgrep -f` casa pelo argv inteiro, então o marcador precisa estar NO
 * argv do processo sondado — um `# comentário` some no parse do shell e não
 * apareceria.
 *
 * O `[S]` no padrão não é enfeite: sem ele, a linha de comando do PRÓPRIO
 * `pgrep` (e do shell que o `execSync` cria) contém o marcador literal e
 * casa consigo mesma, então `markerAlive()` às vezes respondia "vivo" com o
 * processo já morto. Isso deu um FAIL intermitente que parecia bug do
 * escalonamento de kill e não era — a escada estava certa, a sonda é que se
 * enxergava. `[S]TELLAR…` casa a mesma coisa sem conter a string literal. */
function markerAlive() {
  const pattern = `[${MARKER[0]}]${MARKER.slice(1)}`;
  try {
    return execSync(`pgrep -f '${pattern}' || true`, { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}
async function waitForMarkerGone(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!markerAlive()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !markerAlive();
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

  const bashA = (await toolJson("list_cards", {})).cards.find((c) => c.kind === "terminal").id;

  // `exec` é o ponto: substitui o shell, então quem ignora os sinais passa
  // a ser o PRÓPRIO processo do PTY — que é o caso real (uma CLI de agente
  // com handler de shutdown), não um neto qualquer.
  await toolJson("send_to_card", {
    target: bashA,
    text: `exec sh -c 'trap "" HUP TERM; while true; do sleep 1; done' ${MARKER}`,
  });
  await new Promise((r) => setTimeout(r, 2000));
  check("o processo que resiste a HUP/TERM está rodando no card", markerAlive(), true);
  check("...e o card se reporta vivo", (await toolJson("card_status", { target: bashA })).status, "running");

  // --- sai da sessão ---
  const homeBtn = await centerOf(page, ".topbar-home");
  await page.click(homeBtn.x, homeBtn.y);

  // A escada é HUP → 2s → TERM → 2s → KILL; a folga cobre o agendamento.
  check("sair da sessão encerra mesmo um processo que ignora HUP e TERM", await waitForMarkerGone(12_000), true);

  // --- escopo: na Home não há card operável ---
  const onHome = await toolJson("list_cards", {});
  check("na Home o list_cards fica vazio (nenhum card montado pra operar)", onHome.cards.length, 0);

  // --- sessão nova: só os cards dela ---
  await bootIntoFreshSession(page, "Sessao B");
  await new Promise((r) => setTimeout(r, 1500));
  const onB = await toolJson("list_cards", {});
  check("depois de trocar, o list_cards traz só a sessão aberta", onB.cards.every((c) => c.id !== bashA), true);
  check("...e ela tem o próprio terminal", onB.cards.some((c) => c.kind === "terminal"), true);
  const staleStatus = await toolJson("card_status", { target: bashA });
  check(
    "um card da sessão anterior responde 'não existe', não 'exited' (era isso que lia como 'a sessão antiga continua lá')",
    staleStatus.ok === false && /no open terminal card/.test(staleStatus.error ?? ""),
    true,
  );
} finally {
  finish();
  await stopApp(app);
  await new Promise((r) => setTimeout(r, 600));
  if (markerAlive()) {
    console.error("AVISO: o processo marcado sobreviveu até o fim do teste — limpando");
    try {
      execSync(`pkill -9 -f '[${MARKER[0]}]${MARKER.slice(1)}'`);
    } catch {
      /* nada a fazer */
    }
  }
}
