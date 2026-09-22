// Live proof: Fila chips for implementer "aprovado" vs reviewer "aprovado"
// are visibly different (muted "propõe concluir" vs green "aprovado").
// Isolated Electron profile only — never the owner's DB.
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  startApp,
  stopApp,
  connectPage,
  makeChecker,
  bootIntoFreshSession,
  pickFreePort,
  spawnCard,
} from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-verdict-chip-honesty-${CDP_PORT}`, import.meta.url).pathname;
const PROOF_PNG = new URL(`../../.verify-tmp/verdict-chip-honesty-${CDP_PORT}.png`, import.meta.url).pathname;

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
async function callTool(name, args) {
  const rpc = await mcpCall("tools/call", { name, arguments: args });
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args) {
  return JSON.parse((await callTool(name, args)).content[0].text);
}

async function clickModalButton(page, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
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
    if (coords) {
      await page.click(coords.x, coords.y);
      return;
    }
    await delay(200);
  }
  throw new Error(`no modal button labeled "${label}"`);
}

async function spawnBash(page, requesterId, args) {
  const spawnPromise = callTool("spawn_agent", { provider: "bash", callerCardId: requesterId, ...args });
  await delay(500);
  await clickModalButton(page, "Permitir");
  const payload = JSON.parse((await spawnPromise).content[0].text);
  if (!payload.ok || typeof payload.cardId !== "string") {
    throw new Error(`spawn_agent failed: ${JSON.stringify(payload)}`);
  }
  await delay(400);
  return payload.cardId;
}

async function reportVerdict(page, cardId, verdict, taskId) {
  // Wait for the bash PTY to be ready (prompt), then report, then wait
  // for the structured channel — a fixed 600ms race was losing the
  // verdict before the Fila check (live fail 2026-09-14).
  // `pty:write` requires origin ("human"|"delivery"|"auto"); without it
  // the main handler no-ops (scrollback stayed at the bare prompt).
  await delay(800);
  const waitPromise = callTool("read_report", { target: cardId, wait: true, timeoutMs: 15000 });
  await delay(300);
  const obj = { ok: true, result: `chip-honesty-${verdict}`, verdict };
  if (taskId) obj.taskId = taskId;
  const json = JSON.stringify(obj).replace(/"/g, '\\"');
  await page.evalJs(
    `window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify(`acbridge report "${json}"\r`)}, "human")`,
  );
  const waited = JSON.parse((await waitPromise).content[0].text);
  if (!waited.ok) {
    const scroll = await toolJson("read_card", { target: cardId }).catch((e) => ({ error: String(e) }));
    throw new Error(`reportVerdict(${cardId}, ${verdict}) did not land: ${JSON.stringify({ waited, scroll })}`);
  }
  return waited;
}

/** Manda um report com verdict e devolve o que NÃO pousou — usado onde o gate
 * de veredito RECUSA (implementer julgando o próprio trabalho). Devolve o
 * `read_report` (que deve dar timeout) e o scrollback do card, onde a recusa
 * fica escrita. */
async function reportVerdictExpectRefusal(page, cardId, verdict) {
  await delay(800);
  const waitPromise = callTool("read_report", { target: cardId, wait: true, timeoutMs: 4000 });
  await delay(300);
  const json = JSON.stringify({ ok: true, result: `chip-honesty-${verdict}`, verdict }).replace(/"/g, '\\"');
  await page.evalJs(
    `window.pty.write(${JSON.stringify(cardId)}, ${JSON.stringify(`acbridge report "${json}"\r`)}, "human")`,
  );
  const waited = JSON.parse((await waitPromise).content[0].text);
  const scroll = await toolJson("read_card", { target: cardId }).catch((e) => ({ ok: false, error: String(e) }));
  return { waited, scroll };
}

const { check, finish } = makeChecker();
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1000);
  await bootIntoFreshSession(page, "Chip Honesty", { spawnTerminal: true });
  await delay(400);
  await spawnCard(page, "task");
  check("Fila monta", await page.evalJs(`!!document.querySelector('[data-part="create-task-input"]')`), true);

  const boardId = await page.evalJs(`
    (async () => {
      const boards = await window.store.boards.list();
      const board = boards.find((b) => b.name === "Chip Honesty") ?? boards[0];
      return board.id;
    })()
  `);

  const cards0 = await toolJson("list_cards", {});
  const seedId = cards0.cards.find((c) => c.kind === "terminal")?.id;
  check("tem terminal seed", typeof seedId, "string");

  // Task A — o veredito do IMPLEMENTER é RECUSADO pelo gate de veredito.
  //
  // ESTE CASO EXISTE PARA TRAVAR A RECUSA, não para produzir um chip. Um
  // implementer não emite veredito sobre o próprio trabalho (autoaprovação não
  // é revisão), então a asserção correta aqui é que NADA foi gravado.
  // NÃO "conserte" isto de volta para um `aprovado` de implementer: a recusa é
  // o contrato desde 19/09, e é o que impede a autoaprovação pela porta do
  // report. (Este arquivo nasceu esperando esse `aprovado` — e o que ele
  // precisava de verdade era `role=reviewer`, que é o caso B.)
  const implA = await spawnBash(page, seedId, { reason: "chip-honesty implementer A" });
  const taskA = await toolJson("create_task", {
    prompt: "PROVA chip — veredito do IMPLEMENTER (recusado)",
    provider: "bash",
    cardId: implA,
    boardId,
  });
  check("task A criada", taskA.ok, true);
  const refusedA = await reportVerdictExpectRefusal(page, implA, "aprovado");
  check("report com verdict de implementer NÃO pousa", refusedA.waited.ok, false);
  check(
    "...e a recusa NOMEIA a regra (implementer não emite veredito)",
    /implementer não emite veredito/.test(refusedA.scroll.text || ""),
    true,
  );

  // Task B — reviewer "aprovado" (o chip verde de verdade). Removemos a
  // gambiarra dos "cards separados": o mesmíssimo card (implA) que é o
  // implementer da Task A agora atua como reviewer da Task B. O conserto do
  // fan-out garante que o veredito será carimbado SÓ na Task B (como reviewer),
  // passando limpo pelo gate.
  const implB = await spawnBash(page, seedId, { reason: "chip-honesty implementer B" });
  const taskB = await toolJson("create_task", {
    prompt: "PROVA chip — veredito do REVIEWER",
    provider: "bash",
    cardId: implB,
    boardId,
  });
  check("task B criada", taskB.ok, true);

  // `callerCardId` NAO e decoracao: a porta de autorizacao (task 05055482)
  // recusa quem se auto-vincula como revisor, e o smoke atravessa como o card
  // seed, que e quem de fato coordena aqui. Sem isso a chamada e recusada e o
  // veredito seguinte cai por falta de vinculo.
  const linked = await toolJson("link_task_card", { taskId: taskB.taskId, cardId: implA, role: "reviewer", callerCardId: seedId });
  check("link_task_card como reviewer e ACEITO (autoria declarada)", linked.ok, true);
  await reportVerdict(page, implA, "aprovado", taskB.taskId);

  // Fila listens on push; give the board a beat to paint chips.
  await delay(1500);

  const board = JSON.parse(
    await page.evalJs(`
      (async () => {
        const tasks = await window.tasks.listByBoard(${JSON.stringify(boardId)});
        const pick = (promptPart) => {
          const t = tasks.find((x) => (x.prompt || "").includes(promptPart));
          if (!t) return null;
          return {
            id: t.id,
            status: t.status,
            verdicts: t.verdicts,
            cards: t.cards.map((c) => ({ role: c.role, cardId: c.cardId })),
          };
        };
        return JSON.stringify({
          a: pick("IMPLEMENTER"),
          b: pick("REVIEWER"),
        });
      })()
    `),
  );
  console.log(`LIVE_PROOF_BOARD=${JSON.stringify(board)}`);

  // Task A: ZERO linhas. A recusa do gate não fecha rodada com veredito — e é
  // isso que este passo prende. O chip muted ("propõe concluir") que este
  // arquivo nasceu para cobrir só pode virar DADO por linha HISTÓRICA hoje: a
  // porta do report não produz mais um `aprovado` de implementer. Quem lê esse
  // chip em produção está olhando dado velho — ver task 156e6d08.
  check("task A NÃO tem NENHUMA linha de veredito (a recusa não grava)", board.a?.verdicts?.length ?? -1, 0);
  check("task B tem veredito reviewer/aprovado", board.b?.verdicts?.some((v) => v.role === "reviewer" && v.verdict === "aprovado"), true);
  check("task A e B ainda running (proposta visível)", board.a?.status === "running" && board.b?.status === "running", true);

  const chips = JSON.parse(
    await page.evalJs(`
      (() => {
        const items = [...document.querySelectorAll("[data-task-item-id]")];
        const read = (needle) => {
          const item = items.find((el) => (el.textContent || "").includes(needle));
          if (!item) return null;
          const chip = item.querySelector('[data-part="verdict-chip"]');
          if (!chip) return { foundItem: true, label: null, tone: null, bg: null };
          const cs = getComputedStyle(chip);
          return {
            foundItem: true,
            label: (chip.textContent || "").trim().toLowerCase(),
            tone: chip.getAttribute("data-tone"),
            bg: cs.backgroundColor,
          };
        };
        return JSON.stringify({
          implementer: read("IMPLEMENTER"),
          reviewer: read("REVIEWER"),
        });
      })()
    `),
  );

  // Task A não tem veredito → não há chip para ela, e a asserção é a AUSÊNCIA.
  // O par "muted × green lado a lado" que este arquivo nasceu cobrindo não é
  // mais produzível pela porta do report: só DADO HISTÓRICO tem veredito de
  // implementer, e quem exibe isso hoje está olhando dado velho (156e6d08).
  check("chip da task A AUSENTE (sem veredito, sem chip)", chips.implementer?.label ?? null, null);
  check("chip reviewer presente", Boolean(chips.reviewer?.label), true);
  check("chip reviewer = aprovado", chips.reviewer?.label, "aprovado");
  check("chip reviewer tone=good", chips.reviewer?.tone, "good");

  await page.send("Page.enable");
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(PROOF_PNG, Buffer.from(shot.data, "base64"));
  check("png da prova gravado", Boolean(shot.data), true);
  console.log(`LIVE_PROOF_PNG=${PROOF_PNG}`);
  console.log(`LIVE_PROOF_CHIPS=${JSON.stringify(chips)}`);

  page.close();
} finally {
  await stopApp(app);
}
finish();
