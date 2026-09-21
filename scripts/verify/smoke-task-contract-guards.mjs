// Task 5412f61e (2026-09-21) — os DOIS guardas de contrato de task, no app
// de verdade. O resto da task é puro (`decideTaskCwdWithinRoot` /
// `decideGatesAuthorship`) e já tem teste unitário; o que este smoke cobre é
// justamente o DELTA que o unitário não cobre: a FIAÇÃO em `index.ts`
// (`getBoardCwd` → `store.getBoard(boardId).cwd`) e o app real por trás dela.
//
// Fala pelo `acbridge`, que é o MESMO `handleRequest` do bus — logo exercita
// `create_task`/`update_task` de ponta a ponta, com o banco de verdade, sem
// stub nenhum. A raiz declarada NÃO é assumida: é LIDA do app
// (`window.store.boards.list()`), e o smoke falha se ela vier vazia — um
// smoke que assume a raiz não provaria nada sobre "raiz declarada".
//
//   (1) `cwd` FORA da raiz declarada      → recusado nomeando `cwd`;
//   (2) `cwd` DENTRO                      → aceito e gravado;
//   (3) gates em board SEM marca          → aceito + registrado (não brickar);
//   (4) gates de card que NÃO é a marca   → recusado nomeando `gates`;
//   (5) APAGAR os gates existentes        → recusado (a porta dos fundos);
//   (6) gates do próprio card marcado     → aceito e gravados.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
  SEL,
} from "./cdp-client.mjs";

const execFileAsync = promisify(execFile);
const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-task-contract-guards-${CDP_PORT}`, import.meta.url).pathname;
const ACBRIDGE_BIN = new URL("../../resources/bin/acbridge", import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Roda o app real pelo bus real. Resposta `ok:false` do bus vira exit != 0
 * com o texto da recusa em stderr — é assim que uma recusa é medida aqui.
 *
 * `AGENT_CANVAS_CARD_ID` é LIMPO quando o chamador quer ser anônimo, e isso
 * não é detalhe: sem limpar, o filho herda a identidade do card que roda o
 * smoke e o caso "anônimo" vira "sou eu, um card qualquer" — medido na 1ª
 * execução (a recusa voltou com `quem chamou foi 97924145`). Um smoke que
 * herda identidade prova outra coisa que não a que ele afirma. */
async function acbridge(sockPath, cardId, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [ACBRIDGE_BIN, ...args], {
      env: {
        ...process.env,
        AGENT_CANVAS_SOCK: sockPath,
        AGENT_CANVAS_CARD_ID: cardId || "",
      },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { ok: false, code: err.code, stdout: (err.stdout ?? "").trim(), stderr: (err.stderr ?? "").trim() };
  }
}

/** Cria um card de terminal pelo rail, na MESMA sequência que o
 * `bootIntoFreshSession` usa (o `spawnCard` do harness para no popover e NÃO
 * clica o submit — com ele o card nunca nasce, e o smoke ficaria com um card
 * só, medido na 1ª execução). */
async function addTerminalCard(page) {
  const pick = async (selector, what) => {
    const coords = JSON.parse(
      await page.evalJs(`
        (() => {
          const b = document.querySelector(${JSON.stringify(selector)});
          if (!b) return JSON.stringify(null);
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()
      `),
    );
    if (!coords) throw new Error(`${what} not found`);
    return coords;
  };
  const add = await pick(SEL.railAddCard, "rail [data-role=rail-add-card]");
  await page.click(add.x, add.y);
  await delay(250);
  const option = await pick(SEL.popoverKind("terminal"), "terminal option in add-card popover");
  await page.click(option.x, option.y);
  await delay(250);
  const submit = await pick(".popover-actions button.primary", "terminal popover submit");
  await page.click(submit.x, submit.y);
  await delay(800);
}

/** Fronteira de diretório, a MESMA regra do fonte — usada só para escolher um
 * caminho comprovadamente FORA, e para falhar alto se a escolha não servir. */
function isInside(candidate, root) {
  const c = candidate.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1500);
  await bootIntoFreshSession(page, "Guards de contrato de task");
  // Um SEGUNDO card de verdade: sem ele, "um card que NÃO é o orquestrador"
  // cairia no chamador anônimo — que é OUTRO caso — e o smoke passaria
  // afirmando algo que não exercitou (aconteceu na 1ª execução deste script).
  await addTerminalCard(page);

  const sockPath = `${USER_DATA_DIR}/agent-canvas.sock`;

  // A RAIZ DECLARADA vem do app (o que a fiação entrega ao bus), nunca de uma
  // suposição do script.
  const boards = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b))`));
  const board = boards[boards.length - 1];
  const root = typeof board?.cwd === "string" ? board.cwd : "";
  check("o board do smoke tem raiz DECLARADA (boards.cwd não vazio)", root.length > 0, true);
  check("...e o board começa SEM marca de orquestrador", board?.orchestrator_card_id ?? null, null);

  const outside = root.startsWith("/etc") ? "/var/tmp" : "/etc";
  check("o caminho de teste está mesmo FORA da raiz declarada", isInside(outside, root), false);

  // (1) cwd fora da raiz declarada → recusa nomeando o campo.
  const refusedCwd = await acbridge(sockPath, "", [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: cwd fora", cwd: outside }),
  ]);
  check("create_task com cwd FORA da raiz é RECUSADO pelo app real", refusedCwd.ok, false);
  check(
    "...a recusa nomeia `cwd` e mostra a raiz declarada",
    refusedCwd.stderr.includes("`cwd`") && refusedCwd.stderr.includes(root),
    true,
  );
  check("...e diz que nada foi gravado", refusedCwd.stderr.includes("Nada foi gravado"), true);

  // (2) cwd dentro da raiz → aceito, e o cwd chega no banco.
  const inside = `${root}/stellar-smoke-inside`;
  const acceptedCwd = await acbridge(sockPath, "", [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: cwd dentro", cwd: inside }),
  ]);
  check("create_task com cwd DENTRO da raiz é ACEITO", acceptedCwd.ok && acceptedCwd.stdout.length > 0, true);
  const readBack = await acbridge(sockPath, "", ["get-task", acceptedCwd.stdout]);
  check("...e o cwd gravado é o que foi validado", readBack.stdout.includes(inside), true);

  // (3) board SEM marca: gates passam (é o caso dos boards 64 e Estudos,
  // medidos com `orchestrator_card_id` NULL) e o fato fica REGISTRADO.
  const unmarkedGates = await acbridge(sockPath, "", [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: gates sem marca", gates: ["echo smoke-unmarked"] }),
  ]);
  check("board SEM marca: gates são ACEITOS (não brickar o que funciona)", unmarkedGates.ok, true);
  check("...e o registro volta dizendo que o board não tem orquestrador", unmarkedGates.stderr.includes("orquestrador"), true);

  // (4) com marca: um card que NÃO é a marca não declara gates.
  const listResult = await acbridge(sockPath, "", ["list"]);
  const cardIds = listResult.stdout
    .split("\n")
    .map((line) => line.split("\t")[0])
    .filter(Boolean);
  check("há pelo menos dois cards para separar orquestrador de quem não é", cardIds.length >= 2, true);
  if (cardIds.length < 2) {
    // Falha ALTA em vez de degradar: com um card só, o caso abaixo rodaria
    // como anônimo e o PASS seria falso.
    throw new Error("smoke precisa de 2 cards reais; sem isso o caso 'quem NÃO é o orquestrador' não é exercitado");
  }
  const orchestratorCard = cardIds[0];
  const otherCard = cardIds[1];
  const marked = JSON.parse(
    await page.evalJs(
      `window.store.boards.setOrchestratorCard(${JSON.stringify(board.id)}, ${JSON.stringify(orchestratorCard)}).then((r) => JSON.stringify(r))`,
    ),
  );
  check("a marca de orquestrador foi gravada no board", marked, true);

  const workerGates = await acbridge(sockPath, otherCard, [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: gates de worker", gates: ["echo smoke-worker"] }),
  ]);
  check("board COM marca: gates de quem NÃO é o orquestrador são RECUSADOS", workerGates.ok, false);
  check(
    "...a recusa nomeia `gates` e o card marcado",
    workerGates.stderr.includes("`gates`") && workerGates.stderr.includes(orchestratorCard),
    true,
  );

  // Chamador ANÔNIMO é caso distinto e também é recusado: não se presume
  // orquestrador por ausência de identidade.
  const anonymousGates = await acbridge(sockPath, "", [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: gates anônimo", gates: ["echo smoke-anon"] }),
  ]);
  check("board COM marca: chamador ANÔNIMO também é recusado", anonymousGates.ok, false);
  check(
    "...e a recusa nomeia o chamador anônimo (identidade NÃO herdada do smoke)",
    anonymousGates.stderr.includes("anônimo"),
    true,
  );

  // (6) o próprio card marcado declara, e o conjunto chega no banco.
  const orchestratorGates = await acbridge(sockPath, orchestratorCard, [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: gates do orquestrador", gates: ["echo smoke-orchestrator"] }),
  ]);
  check("board COM marca: o card marcado declara gates", orchestratorGates.ok && orchestratorGates.stdout.length > 0, true);
  const gatedTaskId = orchestratorGates.stdout;

  // (5) APAGAR o conjunto existente é autoria também — a porta dos fundos.
  const clearedByWorker = await acbridge(sockPath, otherCard, ["update-task", gatedTaskId, JSON.stringify({ gates: null })]);
  check("APAGAR os gates existentes por quem não é o orquestrador é RECUSADO", clearedByWorker.ok, false);
  check("...a recusa nomeia `gates`", clearedByWorker.stderr.includes("`gates`"), true);

  const listed = await acbridge(sockPath, "", ["list-tasks", "--board", board.id]);
  check("...e o conjunto recusado NÃO vazou para o banco", listed.stdout.includes("echo smoke-orchestrator"), true);
  check("...nem o conjunto do worker recusado", listed.stdout.includes("echo smoke-worker"), false);

  page.close();
} finally {
  await stopApp(app);
}
finish();
