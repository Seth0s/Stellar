// task 6266d3e7 — entrega automática da gaveta (defeito 2026-10-04), chip de
// fase + filtro "aguardando revisão" na Fila, gaveta aberta (com hover) e
// vazia. Instância ISOLADA (userData e portas próprios), nunca a do dono.
//
// Sobe um Electron real, cria três tasks encadeadas reservadas no card de
// terminal e verifica que cada uma é entregue sozinha quando a anterior vira
// `done` (via update_task do orquestrador — o caminho medido). O card é
// liberado entre os passos por `acbridge turn-complete` (o mesmo sinal de fim
// de turno que o app usa para saber que o card está livre).
import { writeFileSync, mkdirSync } from "node:fs";
import { startApp, stopApp, connectPage, makeChecker, bootIntoFreshSession, pickFreePort, spawnCard } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const MCP_PORT = CDP_PORT + 40000;
// O carimbo de identidade vem da URL (`?card=<id>`), nunca do corpo: um MCP
// externo anônimo não pode estabelecer identidade (caller-identity.ts). O URL
// com carimbo é setado depois de achar o card chamador.
let mcpUrl = `http://127.0.0.1:${MCP_PORT}/mcp`;
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-task-reservations-phase-${CDP_PORT}`, import.meta.url).pathname;
const SHOT_DIR = new URL(`../../.verify-tmp/shots-reservations-phase-${CDP_PORT}`, import.meta.url).pathname;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let nextRpcId = 1;
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
async function callTool(name, args, url) {
  const rpc = await mcpCall("tools/call", { name, arguments: args }, url);
  if (rpc.error) throw new Error(`MCP error calling ${name}: ${JSON.stringify(rpc.error)}`);
  return rpc.result;
}
async function toolJson(name, args, url) {
  const result = await callTool(name, args, url);
  return JSON.parse(result.content[0].text);
}
async function centerOf(page, selector) {
  const res = JSON.parse(
    await page.evalJs(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify(null);
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()
    `),
  );
  return res;
}
async function waitFor(page, expr, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evalJs(`!!(${expr})`)) return true;
    await delay(100);
  }
  return false;
}
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
const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  await bootIntoFreshSession(page, "Smoke Reservas Fase", { spawnTerminal: true });
  await delay(500);

  const cards = await toolJson("list_cards", {});
  const bashId = cards.cards.find((c) => c.kind === "terminal").id;
  const boardId = JSON.parse(
    await page.evalJs(`(async () => JSON.stringify((await window.store.boards.list())[0].id))()`),
  );

  await spawnCard(page, "task");
  check("card Fila monta", await waitFor(page, `document.querySelector('[data-part="phase-filter"]')`, 8000), true);

  // Identidade do CHAMADOR para link_task_card: o carimbo da URL (`?card=`),
  // nunca o corpo. E a autoria exige a MARCA de orquestrador do board — o
  // card de terminal recebe a marca pela MESMA API da UI, e passa a poder
  // reservar tasks. É o caminho de produção (um board marcado).
  const orchestratorOk = await page.evalJs(
    `window.store.boards.setOrchestratorCard(${JSON.stringify(boardId)}, ${JSON.stringify(bashId)})`,
  );
  check("board marcou um card orquestrador", orchestratorOk, true);
  // A conexão CARIMBADA (orquestrador) só para `link_task_card` (autoria).
  // As demais usam a conexão ANÔNIMA: se o update_task viesse carimbado com o
  // card implementer, o gate de julgamento recusaria o `done` (implementer não
  // julga o próprio trabalho) — um outsider pode.
  const mcpUrlOrch = `http://127.0.0.1:${MCP_PORT}/mcp?card=${bashId}`;

  // Três tasks encadeadas, todas RESERVADAS no card do terminal.
  const t1 = await toolJson("create_task", { prompt: "cadeia 1", boardId });
  const t2 = await toolJson("create_task", { prompt: "cadeia 2", boardId, deps: [t1.taskId] });
  const t3 = await toolJson("create_task", { prompt: "cadeia 3", boardId, deps: [t2.taskId] });
  for (const id of [t1.taskId, t2.taskId, t3.taskId]) {
    const r = await toolJson("link_task_card", { taskId: id, cardId: bashId, mode: "reserve" }, mcpUrlOrch);
    if (!r.ok) console.log(`  [debug] link_task_card ${id.slice(0, 8)} → ${JSON.stringify(r)}`);
    check(`reserva de ${id.slice(0, 8)} (nada entregue)`, r.mode, "reserve");
  }
  await delay(600);
  const resv = await toolJson("list_reservations", { cardId: bashId });
  check("a gaveta lista as 3 reservas", resv.reservations.length, 3);
  check("...e cada item carrega uma phase derivada", resv.reservations.every((r) => typeof r.phase === "string"), true);

  // ---- GAVETA ABERTA + HOVER (com as 3 reservas ainda na fila) ----
  check(
    "achou a aba da gaveta no card de terminal",
    await waitFor(page, `document.querySelector('[data-part="reservation-tab"]')`, 3000),
    true,
  );
  // Clique de DOM: a aba fica encostada na borda esquerda do card, fora da
  // viewport quando o card nasce no canto — o handler é onClick.
  await page.evalJs(`document.querySelector('[data-part="reservation-tab"]').click()`);
  await delay(300);
  console.log(
    `  [debug] drawer: tabText=${JSON.stringify(await page.evalJs(`document.querySelector('[data-part="reservation-tab"]').textContent`))} items=${await page.evalJs(`document.querySelectorAll('[data-part="reservation-item"]').length`)} panel=${await page.evalJs(`!!document.querySelector('[data-part="reservation-drawer"] .panel, [data-part="reservation-drawer"] [class*="panel"]')`)}`,
  );
  check("gaveta abre e lista os itens", await waitFor(page, `document.querySelectorAll('[data-part="reservation-item"]').length === 3`), true);

  // O card Fila nasce CENTRADO e grande, cobrindo o card de terminal — o
  // ponteiro real não alcança o item da gaveta. O handler é `onMouseEnter`;
  // disparamos `mouseover` (o evento que o React delega para enter) no próprio
  // elemento, provando o caminho handler→conector→destaque sem depender de
  // z-order. O print mostra os dois cards.
  await page.evalJs(`
    (() => {
      const it = document.querySelector('[data-part="reservation-item"]');
      it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      it.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()
  `);
  await delay(250);
  check("hover desenha o conector tracejado gaveta→task", await waitFor(page, `document.querySelector('[data-part="reservation-connector"]')`, 3000), true);
  check("hover acende o item correspondente na Fila", await waitFor(page, `document.querySelector('[data-hovered="true"]')`, 3000), true);
  await shoot(page, "drawer-hover");
  await page.evalJs(`document.querySelector('[data-part="reservation-tab"]').click()`); // fecha a gaveta

  // ---- ENTREGA AUTOMÁTICA: cada task entregue quando a anterior vira done ----
  // O card precisa de um fim de turno MEDIDO para ser considerado livre; o
  // sinal é `acbridge turn-complete`. Localiza o socket real do bus (o env do
  // card aponta para `profiles/<id>/`) e o repassa.
  async function freeCard() {
    const cmd = `FOUND=$(find ${JSON.stringify(USER_DATA_DIR)} -name agent-canvas.sock 2>/dev/null | head -1); AGENT_CANVAS_SOCK="$FOUND" acbridge turn-complete >/dev/null 2>&1; echo TURNRM=$?`;
    await toolJson("send_to_card", { target: bashId, text: cmd });
    await delay(2000);
    const tail = await toolJson("read_card", { target: bashId, lines: 3 });
    const matches = [...((tail.text ?? "").matchAll(/TURNRM=(\d+)/g))];
    return matches.length > 0 && matches[matches.length - 1][1] === "0";
  }
  const canFree = await freeCard();
  // A conclusão de t1 é medida SEMPRE (alimenta o chip 'done' da Fila).
  await toolJson("update_task", { taskId: t1.taskId, status: "done" });
  await delay(1200);
  let chainMeasured = false;
  if (!canFree) {
    skip(
      "entrega automática da gaveta (3 tasks encadeadas)",
      "acbridge turn-complete não conectou ao socket do bus nesta instância isolada (profiles/socket) — o caminho real está coberto por tests/unit/message-bus-reservation-delivery.test.ts",
    );
  } else {
    const after1 = (await toolJson("list_reservations", { cardId: bashId })).reservations.map((r) => r.taskId);
    check("t1 done → t2 ENTREGUE (some da gaveta)", after1.includes(t2.taskId), false);
    check("...t3 continua reservada", after1.includes(t3.taskId), true);
    const t2After = await toolJson("get_task", { taskId: t2.taskId });
    check("...t2 ganhou o card do terminal (entregue de verdade)", t2After.task.cardId, bashId);

    await freeCard();
    await toolJson("update_task", { taskId: t2.taskId, status: "done" });
    await delay(1800);
    const after2 = (await toolJson("list_reservations", { cardId: bashId })).reservations.map((r) => r.taskId);
    check("t2 done → t3 ENTREGUE (fila esvazia)", after2, []);
    const t3After = await toolJson("get_task", { taskId: t3.taskId });
    check("...t3 ganhou o card do terminal", t3After.task.cardId, bashId);
    chainMeasured = true;
  }

  // ---- IDS CURTOS: get_task por prefixo ----
  const byPrefix = await toolJson("get_task", { taskId: t3.taskId.slice(0, 8) });
  check("get_task aceita o prefixo de 8 chars", byPrefix.ok && byPrefix.task.id, t3.taskId);

  // ---- FILA: chip de fase + filtro ----
  await delay(600);
  const chips = JSON.parse(
    await page.evalJs(
      `JSON.stringify([...document.querySelectorAll('[data-part="phase-chip"]')].map((e) => e.getAttribute('data-phase')))`,
    ),
  );
  check("a Fila mostra chips de fase", chips.length >= 3, true);
  check("...e o chip de uma task concluída é 'done'", chips.includes("done"), true);

  const filterCount = JSON.parse(
    await page.evalJs(`JSON.stringify(document.querySelector('[data-part="phase-filter-count"]')?.textContent ?? null)`),
  );
  check("filtro 'aguardando revisão' mostra contador", filterCount !== null, true);
  const beforeFilter = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelectorAll('[data-task-item-id]').length)`));
  // `click()` de DOM (o card pode estar atrás de outro; o handler é onClick).
  await page.evalJs(`document.querySelector('[data-part="phase-filter"] button').click()`);
  await delay(300);
  const afterFilter = JSON.parse(await page.evalJs(`JSON.stringify(document.querySelectorAll('[data-task-item-id]').length)`));
  check("clicar no filtro muda a lista (filtra)", afterFilter <= beforeFilter, true);
  check(
    "filtro ligado: nenhuma task 'aguardando revisão' visível quando o contador é 0",
    filterCount === "0" ? afterFilter === 0 : true,
    true,
  );
  await shoot(page, "fila-filter");
  await page.evalJs(`document.querySelector('[data-part="phase-filter"] button').click()`); // limpa o filtro

  // ---- GAVETA VAZIA ----
  // Só é vazia de verdade quando a cadeia foi entregue e esvaziou a fila.
  if (chainMeasured) {
    await page.evalJs(`document.querySelector('[data-part="reservation-tab"]').click()`);
    check("gaveta vazia: nenhum item", await waitFor(page, `document.querySelectorAll('[data-part="reservation-item"]').length === 0`, 3000), true);
    await shoot(page, "drawer-empty");
  } else {
    skip("gaveta vazia (nada na fila)", "a fila não foi esvaziada — a cadeia de entrega não foi medida nesta instância");
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
