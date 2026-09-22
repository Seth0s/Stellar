// Task 05055482 (2026-09-21) — a AUTORIA DE PAPEL no app de verdade: quem
// pode atribuir `task_cards.role` e mover o principal. As decisões são puras
// (`decideTaskCardLinkAuthorship` / `decidePrincipalRepointAuthorship` /
// `decideReviewerSpawnAuthorship`) e têm teste unitário; o que este smoke
// cobre é o DELTA que o unitário não cobre: a FIAÇÃO nos handlers do bus do
// app real, com a identidade vindo do MESMO eixo do acbridge
// (`AGENT_CANVAS_CARD_ID`) e a marca do board gravada no banco de verdade.
//
// Fala pelo `acbridge` (o MESMO `handleRequest` do bus), como o molde
// smoke-task-contract-guards.mjs. EXCEÇÃO MEDIDA: o spawn da porta 3 vai por
// SOCKET CRU com o mesmo JSON do acbridge — o acbridge não tem `--reason`,
// e o bus RECUSA spawn de card identificado sem motivo
// (`decideSpawnReason`), então por acbridge o caso nem chegaria ao gate
// sob teste. O socket é o mesmo `handleRequest`; a sonda do Revisor B o usou.
//
//   (1) board SEM marca: card linka a si mesmo reviewer  → RECUSADO (P1);
//   (2) board SEM marca: chamador anônimo               → RECUSADO (não
//       presume orquestrador por ausência de identidade — 5412f61e);
//   (3) marca gravada no UI: a marca linka revisor       → ACEITO (o fluxo
//       desta sessão inteira);
//   (4) com marca: card linka a SI MESMO reviewer        → RECUSADO (P1);
//   (5) update_task {cardId: si} em task COM principal   → RECUSADO (P2);
//   (6) update_task {cardId: si} em task SEM principal   → ACEITO (adoção);
//   (7) board autônomo: não-marca spawna revisor         → RECUSADO (nenhum
//       card criado); spawn SEM role do mesmo card       → ACEITO (o caminho
//       do agente que cria um filho, intacto).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
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
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-role-authority-${CDP_PORT}`, import.meta.url).pathname;
const ACBRIDGE_BIN = new URL("../../resources/bin/acbridge", import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Roda o app real pelo bus real. Resposta `ok:false` do bus vira exit != 0
 * com o texto da recusa em stderr — é assim que uma recusa é medida aqui.
 * `AGENT_CANVAS_CARD_ID` é LIMPO quando o chamador quer ser anônimo (o molde
 * mediu: sem limpar, o filho herda a identidade do card que roda o smoke e o
 * caso "anônimo" vira "sou eu"). */
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

/** A MESMA porta do acbridge (um `handleRequest` do bus), com o corpo livre —
 * usada só para o spawn, que o acbridge não consegue enviar por falta de
 * `--reason`. Uma linha de JSON entra, uma linha de JSON sai. */
function busSend(sockPath, request) {
  return new Promise((resolve, reject) => {
    const client = connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`bus timeout: ${JSON.stringify(request).slice(0, 120)}`));
    }, 15000);
    client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      client.end();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Cria um card de terminal pelo rail — o `spawnCard` do harness para no
 * popover e NÃO clica o submit (medido no molde). */
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

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1500);
  await bootIntoFreshSession(page, "Autoria de papel");
  // TRÊS cards de verdade: marca, implementer/vítima e um terceiro — sem o
  // terceiro, o caso "quem NÃO é a marca nem o principal" viraria outro caso
  // (o molde mediu esta classe de falso-pass com o anônimo herdado).
  await addTerminalCard(page);
  await addTerminalCard(page);
  await addTerminalCard(page);

  const sockPath = `${USER_DATA_DIR}/agent-canvas.sock`;
  const boards = JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b))`));
  const board = boards[boards.length - 1];
  check("o board do smoke começa SEM marca de orquestrador", board?.orchestrator_card_id ?? null, null);

  const listResult = await acbridge(sockPath, "", ["list"]);
  const cardIds = listResult.stdout
    .split("\n")
    .map((line) => line.split("\t")[0])
    .filter(Boolean);
  check("há três cards reais para separar marca, vítima e terceiro", cardIds.length >= 3, true);
  if (cardIds.length < 3) throw new Error("smoke precisa de 3 cards reais para exercitar os três papéis");
  const [markCard, victimCard, otherCard] = cardIds;

  // Tasks pelo bus real: T1 review="wanted" sem principal; T2 com principal
  // (a vítima); T3 sem principal (a órfã reivindicável).
  const t1 = await acbridge(sockPath, markCard, [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: revisada por revisor de verdade", review: "wanted" }),
  ]);
  check("create-task com review=wanted é aceito", t1.ok, true);
  const t2 = await acbridge(sockPath, markCard, [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: task da vítima", cardId: victimCard }),
  ]);
  check("create-task com cardId atribui o principal", t2.ok, true);
  const t3 = await acbridge(sockPath, markCard, [
    "create-task",
    JSON.stringify({ boardId: board.id, prompt: "smoke: task órfã" }),
  ]);
  check("create-task sem cardId deixa a task sem principal", t3.ok, true);

  // (1) board SEM marca: o card linka a SI MESMO como reviewer — P1.
  const selfReviewUnmarked = await acbridge(sockPath, otherCard, [
    "link-task-card", t1.stdout, otherCard, "reviewer",
  ]);
  check("board SEM marca: self-link como revisor é RECUSADO", selfReviewUnmarked.ok, false);
  check("...a recusa nomeia a auto-atribuição e diz que nada foi gravado",
    selfReviewUnmarked.stderr.includes("REVISOR") && selfReviewUnmarked.stderr.includes("Nada foi gravado"), true);

  // (2) anônimo não presume orquestrador (o princípio da 5412f61e para gates).
  const anonymousLink = await acbridge(sockPath, "", [
    "link-task-card", t1.stdout, victimCard, "reviewer",
  ]);
  check("board SEM marca: chamador anônimo também é RECUSADO", anonymousLink.ok, false);
  check("...e a recusa diz por quê (identidade ausente)", anonymousLink.stderr.includes("anônimo"), true);

  // (3) a marca gravada NO UI linka revisor — o fluxo desta sessão inteira.
  const marked = JSON.parse(
    await page.evalJs(
      `window.store.boards.setOrchestratorCard(${JSON.stringify(board.id)}, ${JSON.stringify(markCard)}).then((r) => JSON.stringify(r))`,
    ),
  );
  check("a marca de orquestrador foi gravada no board", marked, true);
  const markLinks = await acbridge(sockPath, markCard, [
    "link-task-card", t1.stdout, victimCard, "reviewer",
  ]);
  check("board COM marca: a marca linka revisor sem atrito", markLinks.ok, true);
  const readBack = await acbridge(sockPath, markCard, ["get-task", t1.stdout]);
  check("...e o papel chega ao banco como reviewer", readBack.stdout.includes("reviewer"), true);

  // (4) com marca: o TERCEIRO card self-linka revisor — P1 de novo.
  const selfReviewMarked = await acbridge(sockPath, otherCard, [
    "link-task-card", t2.stdout, otherCard, "reviewer",
  ]);
  check("com marca: card não-marcado NÃO se declara revisor da task alheia", selfReviewMarked.ok, false);
  check("...a recusa nomeia a auto-atribuição", selfReviewMarked.stderr.includes("REVISOR"), true);

  // (5) P2: o terceiro aponta o principal da task da vítima para SI MESMO.
  const theft = await acbridge(sockPath, otherCard, [
    "update-task", t2.stdout, JSON.stringify({ cardId: otherCard }),
  ]);
  check("P2: update_task {cardId: si} sobre task COM principal é RECUSADO", theft.ok, false);
  check("...a recusa fala de principal e diz que nada foi gravado",
    theft.stderr.includes("principal") && theft.stderr.includes("Nada foi gravado"), true);

  // (6) a adoção de órfã fica aberta: task SEM principal é reivindicável.
  const claim = await acbridge(sockPath, otherCard, [
    "update-task", t3.stdout, JSON.stringify({ cardId: otherCard }),
  ]);
  check("task SEM principal é reivindicável pelo card (adoção, não roubo)", claim.ok, true);
  const readClaim = await acbridge(sockPath, markCard, ["get-task", t3.stdout]);
  check("...e o principal da órfã é o card que a reivindicou", readClaim.stdout.includes(otherCard), true);

  // (7) porta 3 — board AUTÔNOMO (o modal de consentimento é pulado).
  await page.evalJs(`document.querySelector('.rail-btn[title="Configurações"]')?.click()`);
  check("settings abre pelo rail",
    await (async () => {
      for (let i = 0; i < 20; i++) {
        if (JSON.parse(await page.evalJs(`!!document.querySelector('[data-settings-modal]')`))) return true;
        await delay(100);
      }
      return false;
    })(), true);
  await page.evalJs(`document.querySelector('[data-settings-page="maestro"]')?.click()`);
  await delay(300);
  await page.evalJs(`document.querySelector('.autonomous-toggle-label input')?.click()`);
  await delay(300);
  check("board do smoke ficou autônomo",
    JSON.parse(await page.evalJs(`window.store.boards.list().then((b) => JSON.stringify(b.some((x) => x.autonomous)))`)),
    true);

  const reviewerSpawn = await busSend(sockPath, {
    cmd: "spawn_agent", provider: "bash", taskId: t2.stdout, role: "reviewer",
    brief: "revise", reason: "smoke: filho revisor", requesterId: otherCard,
  });
  check("board autônomo: NÃO-marca spawna filho já vinculado revisor → RECUSADO", reviewerSpawn.ok, false);
  check("...a recusa nomeia a auto-atribuição de revisão", String(reviewerSpawn.error ?? "").includes("REVISOR"), true);

  const implSpawn = await busSend(sockPath, {
    cmd: "spawn_agent", provider: "bash", taskId: t2.stdout,
    reason: "smoke: filho implementer", requesterId: otherCard,
  });
  check("o caminho do agente que cria um filho (implementer) segue ABERTO no autônomo", implSpawn.ok, true);

  page.close();
} finally {
  await stopApp(app);
}

finish();
