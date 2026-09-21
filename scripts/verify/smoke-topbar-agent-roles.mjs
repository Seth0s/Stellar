// PROVA AO VIVO (task 49de95ce): o contador do Topbar parou de afirmar "N
// ativos" e o clique abre NOME + PAPÉIS.
//
// O DEFEITO, medido antes deste conserto: `store.ts`'s `cardCountsStmt` tinha
// as DUAS colunas com a MESMA expressão SQL (`agents` e `active` = `SUM(...)`
// de provider != 'bash'), e o `StatusDot` derivava cor e tooltip de
// `active > 0` — então o verde era inalcançável de desligar e o tooltip dizia
// "N agente(s) em execução" sem que nada tivesse medido isso. O print do dono
// ("11 agentes · 11 ativos") era isso: o mesmo número duas vezes.
//
// O QUE ESTE RUN PROVA, e por que não é teste de DOM: no app REAL, com perfil
// isolado, a tela diz o que o main conta (o número do IPC == o número do DOM),
// o campo `active` NÃO existe mais no contrato que o renderer consome, o
// dropdown lista EXATAMENTE os cards de agente do board com o papel de cada
// task ABERTA (e nada de task julgada), o card sem task aberta aparece sem
// papel, e o popover não estoura a janela em 1280px nem em 620px.
//
// A FIXTURE é semeada no banco DO PRÓPRIO perfil isolado (sqlite3), depois de
// um primeiro boot que cria o schema — a mesma postura de
// `smoke-providers-config-seed.mjs`, que escreve o `providers.json` do perfil
// isolado para montar o caso. O userData do dono não é lido nem escrito.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-topbar-agent-roles-${CDP_PORT}`, import.meta.url).pathname;
const DB_PATH = join(USER_DATA_DIR, "agent-canvas.db");

const { check, finish } = makeChecker();

function sql(statements) {
  return execFileSync("sqlite3", [DB_PATH, statements], { encoding: "utf8" }).trim();
}

/** Dois cards de AGENTE semeados, porque o card que o harness cria é `bash` (e
 * bash não é agente — é justamente o que o contador exclui, e ele serve de
 * controle negativo aqui):
 *   - `SEEDED_CARD`: com rótulo e DUAS tasks, uma ABERTA (implementer) e uma
 *     julgada (done, reviewer) — a julgada prova que história não vira papel;
 *   - `SEEDED_CARD_2`: sem rótulo e SEM vínculo — a ausência honesta ("sem
 *     papel" e o id no lugar do nome, nunca um nome inventado). */
const SEEDED_CARD = "4242";
const SEEDED_LABEL = "Card semeado";
const SEEDED_CARD_2 = "4243";
const OPEN_TASK = "aaaa1111-1111-4111-8111-111111111111";
const DONE_TASK = "bbbb2222-2222-4222-8222-222222222222";

/** Sobe o app isolado. `create` só no PRIMEIRO boot: ele é quem cria a sessão
 * (e com ela o board e o card de agente do harness). Nos boots seguintes o
 * perfil JÁ tem o board, e criar de novo daria um SEGUNDO board — com ele, o
 * board medido deixaria de ser o que a fixture semeou. */
async function boot({ bounds = null, create = false } = {}) {
  const app = await startApp({
    cdpPort: CDP_PORT,
    userDataDir: USER_DATA_DIR,
    preserveUserData: true,
    ...(bounds ? { extraEnv: { AGENT_CANVAS_TEST_WINDOW_BOUNDS: JSON.stringify(bounds) } } : {}),
  });
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  if (create) {
    try {
      await bootIntoFreshSession(page, "Agentes do Topbar");
    } catch (err) {
      // Um boot que FALHA não pode deixar app e perfil para trás — medido
      // nesta task: o flake do harness (input do modal ausente sob carga)
      // derrubou a criação da sessão e deixou processo e perfil órfaos, com a
      // execução parecendo quebrada no produto. Falhar é aceitável; deixar
      // entulho não é.
      await stopApp(app);
      if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });
      throw err;
    }
    await delay(600);
  }
  return { app, page };
}

/** Entra no board pelo card da Home (o boot seguinte cai na Home; o Topbar só
 * existe dentro de um board). Idempotente: se já está no board, não faz nada. */
async function enterBoard(page) {
  if (await page.evalJs(`!!document.querySelector('.topbar')`)) return;
  await page.evalJs(`document.querySelector('.home-session-card')?.click()`);
  for (let i = 0; i < 40; i++) {
    if (await page.evalJs(`!!document.querySelector('[data-role="topbar-agents"]')`)) return;
    await delay(150);
  }
}

const COUNTER_TEXT = `document.querySelector('[data-role="topbar-agents"]')?.textContent ?? null`;
const LIST_STATE = `(() => {
  const pop = document.querySelector('[data-role="topbar-agents-list"]');
  if (!pop) return JSON.stringify({ open: false });
  const rect = pop.getBoundingClientRect();
  const rows = [...pop.querySelectorAll('[data-role="topbar-agent-row"]')].map((r) => ({
    cardId: r.getAttribute('data-card-id'),
    text: r.textContent,
    roles: [...r.querySelectorAll('[data-role="topbar-agent-role"]')].map((x) => x.textContent),
  }));
  return JSON.stringify({
    open: true,
    rows,
    hover: document.querySelector('[data-role="topbar-agents"]')?.getAttribute('aria-expanded'),
    fits: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
    note: pop.querySelector('.topbar-agents-note')?.textContent ?? null,
  });
})()`;

/** Abre e espera a LISTA, não só o popover: o conteúdo chega por IPC (o estado
 * "lendo…" existe de propósito, para a tela não mostrar a lista do board
 * anterior por um frame), então esperar só `open` mediria o vazio. */
async function openList(page) {
  await page.evalJs(`document.querySelector('[data-role="topbar-agents"]')?.click()`);
  for (let i = 0; i < 40; i++) {
    const state = JSON.parse(await page.evalJs(LIST_STATE));
    if (state.open && (state.rows.length > 0 || (state.note && state.note !== "lendo…"))) return state;
    await delay(100);
  }
  return JSON.parse(await page.evalJs(LIST_STATE));
}

/**
 * A MEDIÇÃO DA BARRA (o que a tarefa pediu: getComputedStyle no app, 1280 e
 * 620, antes e depois). Antes/depois DENTRO da mesma build: a pílula do título
 * tinha o contador DENTRO dela, com o sufixo "· N ativos"; o sufixo é
 * reinjetado como sonda e a largura da pílula é medida com e sem ele — sem
 * isso o "antes" só existiria noutra build, com outro CSS de outras streams
 * por cima. `overflow` da barra é o critério: > 0 é conteúdo cortado.
 */
const BAR_METRICS = `(() => {
  const bar = document.querySelector('.topbar');
  const pill = document.querySelector('.topbar-title');
  const counter = document.querySelector('[data-role="topbar-agents"]');
  const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
  const pillNow = { client: pill.clientWidth, scroll: pill.scrollWidth };
  const probe = document.createElement('span');
  probe.textContent = ' · 2 ativos';
  pill.appendChild(probe);
  const withOldSuffix = { client: pill.clientWidth, scroll: pill.scrollWidth };
  probe.remove();
  return JSON.stringify({
    innerWidth: window.innerWidth,
    barOverflow: bar.scrollWidth - bar.clientWidth,
    pillWidth: w(pill),
    pillOverflowNow: pillNow.scroll - pillNow.client,
    pillOverflowWithOldSuffix: withOldSuffix.scroll - withOldSuffix.client,
    counterWidth: w(counter),
    counterOverflow: counter ? counter.scrollWidth - counter.clientWidth : null,
  });
})()`;

// ---------------------------------------------------------------------------
// 1) BOOT DE NASCIMENTO: perfil novo, uma sessão criada pela UI (o que gera o
//    board e o card de agente do harness). Só isto é feito aqui — a fixture de
//    papéis é semeada DEPOIS, com o app parado.
// ---------------------------------------------------------------------------
rmSync(USER_DATA_DIR, { recursive: true, force: true });
let boardId = null;
let spawnedCardId = null;
const first = await boot({ create: true });
try {
  boardId = sql("SELECT id FROM boards ORDER BY created_at DESC LIMIT 1;");
  check("o boot criou um board", boardId.length > 0, true);
  spawnedCardId = sql(`SELECT id FROM cards WHERE board_id='${boardId}' AND kind='terminal' ORDER BY rowid LIMIT 1;`);
  check("e um card de agente nele", spawnedCardId.length > 0, true);
  // O card do harness é `bash`: ele NÃO conta como agente nem entra na lista.
  // É o controle negativo desta fixture (sem ele, um bug que listasse todo
  // terminal passaria).
  check("o card do harness é bash (controle negativo)", sql(`SELECT provider FROM cards WHERE id='${spawnedCardId}';`), "bash");

  await enterBoard(first.page);
  const before = JSON.parse(await first.page.evalJs(LIST_STATE));
  check("o dropdown nasce FECHADO", before.open, false);
} finally {
  await stopApp(first.app);
  await delay(600);
}

// ---------------------------------------------------------------------------
// 2) A FIXTURE: um card com rótulo, uma task ABERTA (implementer) e uma task
//    JULGADA (reviewer) — e um segundo card de agente SEM rótulo e SEM
//    vínculo, que é o caso da ausência honesta.
// ---------------------------------------------------------------------------
const now = Date.now();
sql(`
INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, updated_at, label, created_at)
  VALUES ('${SEEDED_CARD}', '${boardId}', 'terminal', 'claude', '/tmp', 10, 10, 400, 300, ${now}, '${SEEDED_LABEL}', ${now});
INSERT INTO cards (id, board_id, kind, provider, cwd, x, y, w, h, updated_at, label, created_at)
  VALUES ('${SEEDED_CARD_2}', '${boardId}', 'terminal', 'claude', '/tmp', 20, 20, 400, 300, ${now}, NULL, ${now});
INSERT INTO tasks (id, status, created_at, updated_at, board_id) VALUES ('${OPEN_TASK}', 'pending', ${now}, ${now}, '${boardId}');
INSERT INTO tasks (id, status, created_at, updated_at, board_id) VALUES ('${DONE_TASK}', 'done', ${now}, ${now}, '${boardId}');
INSERT INTO task_cards (task_id, card_id, role, linked_at, provider) VALUES ('${OPEN_TASK}', '${SEEDED_CARD}', 'implementer', ${now}, 'claude');
INSERT INTO task_cards (task_id, card_id, role, linked_at, provider) VALUES ('${DONE_TASK}', '${SEEDED_CARD}', 'reviewer', ${now}, 'claude');
`);

// ---------------------------------------------------------------------------
// 3) JANELA PADRÃO (1280×800): o número da tela É o do main, e a lista diz
//    nome + papel.
// ---------------------------------------------------------------------------
const second = await boot();
try {
  await enterBoard(second.page);
  const counts = JSON.parse(
    await second.page.evalJs(`(async () => JSON.stringify(await window.store.cardCounts()))()`),
  );
  check("o payload do main NÃO tem mais `active`", Object.prototype.hasOwnProperty.call(counts[boardId] ?? {}, "active"), false);
  check("o main conta os DOIS cards de agente (e não o bash do harness)", counts[boardId]?.agents, 2);

  const wide = JSON.parse(await second.page.evalJs(BAR_METRICS));
  console.log(
    `[49de95ce] 1280px — barra overflow=${wide.barOverflow} · pílula ${wide.pillWidth}px (overflow ${wide.pillOverflowNow}; com o sufixo antigo seria ${wide.pillOverflowWithOldSuffix}) · contador ${wide.counterWidth}px`,
  );

  const text = await second.page.evalJs(COUNTER_TEXT);
  check("a tela diz o MESMO número do main, e sem a palavra 'ativos'", text, `${counts[boardId].agents} agentes abertos`);
  check("e o topbar inteiro não fala mais em 'ativos'", await second.page.evalJs(`document.querySelector('.topbar').textContent.includes('ativos')`), false);

  const opened = await openList(second.page);
  check("o clique abre o dropdown", opened.open, true);
  check("o botão se declara expandido", opened.hover, "true");
  check(
    "a lista traz EXATAMENTE os cards de agente — nem o bash, nem card a mais",
    opened.rows.map((r) => r.cardId).join(","),
    `${SEEDED_CARD},${SEEDED_CARD_2}`,
  );

  const seeded = opened.rows.find((r) => r.cardId === SEEDED_CARD);
  check("a linha do card traz o RÓTULO dele", seeded.text.includes(SEEDED_LABEL), true);
  // O papel é POR TASK: a task aberta aparece, a julgada NÃO (lá o papel é
  // história, e história o card da task mostra).
  check("só a task ABERTA vira papel", seeded.roles.length, 1);
  check("e o papel é o da task aberta, com o id curto dela", seeded.roles[0], (v) => v.includes("implementa") && v.includes(OPEN_TASK.slice(0, 8)));

  // Ausência honesta: sem nome, mostra o ID; sem task aberta, diz que não tem
  // papel — nunca "ocioso" (que seria a afirmação que esta task removeu).
  const roleless = opened.rows.find((r) => r.cardId === SEEDED_CARD_2);
  check("card sem rótulo mostra o próprio id", roleless.text.includes(SEEDED_CARD_2), true);
  check("e card sem task aberta aparece SEM papel", roleless.roles.length, 0);
  check("com a frase da ausência, não um rótulo inventado", roleless.text.includes("sem papel"), true);
  check("o popover cabe na janela", opened.fits, true);

  // Fecha e reabre: o gesto é idempotente e a lista re-lê.
  await second.page.evalJs(`document.querySelector('[data-role="topbar-agents"]')?.click()`);
  await delay(200);
  check("o segundo clique fecha", JSON.parse(await second.page.evalJs(LIST_STATE)).open, false);
} finally {
  await stopApp(second.app);
  await delay(600);
}

// ---------------------------------------------------------------------------
// 4) JANELA ESTREITA (620px): a barra do topo (título + contador + zoom) não
//    pode ganhar overflow, que é o que a tarefa pediu para medir. O contador
//    saiu de dentro do título nesta task — a medição cobre isso.
// ---------------------------------------------------------------------------
const third = await boot({ bounds: { x: 0, y: 0, width: 620, height: 800 } });
try {
  await enterBoard(third.page);
  const bar = JSON.parse(await third.page.evalJs(BAR_METRICS));
  check("620px: a janela é mesmo estreita", bar.innerWidth < 700, true);
  console.log(
    `[49de95ce] 620px — barra overflow=${bar.barOverflow} · pílula ${bar.pillWidth}px (overflow ${bar.pillOverflowNow}; com o sufixo antigo seria ${bar.pillOverflowWithOldSuffix}) · contador ${bar.counterWidth}px`,
  );
  check("620px: sem overflow na barra do topo", bar.barOverflow <= 0, true);
  check("620px: o contador não corta o próprio texto", bar.counterOverflow, 0);
  const narrow = await openList(third.page);
  check("620px: o dropdown abre e cabe", narrow.open && narrow.fits, true);
  check("620px: a lista continua com os dois cards", narrow.rows.length, 2);
} finally {
  await stopApp(third.app);
}

if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });

finish();
