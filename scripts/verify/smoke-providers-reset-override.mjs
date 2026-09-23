// PROVA AO VIVO (task 4c41368f): quem SOBRESCREVEU um provider do app tem
// caminho de volta — e o caminho de volta devolve o PADRÃO DO APP.
//
// O DEFEITO, medido no app rodando antes deste conserto: o botão de reset era
// desenhado só quando `row.source === "file"`, e uma sobrescrita tem
// `source: "app"` (a origem de uma linha é a LISTA em que ela está,
// index.ts:4204-4212). Resultado: `cline` (cópia inteira) e `commandcode`
// (sobrescrita parcial) apareciam com `edit=true, reset=false` — e o único
// caminho de volta era abrir o providers.json e apagar a entrada à mão. Na
// mesma linha em que o badge da edf3b047 diz "sem correção do app": uma promessa
// quebrada ao lado do próprio aviso.
//
// O QUE ESTE RUN PROVA, e por que não é teste de DOM: no app REAL, com perfil
// isolado, (1) a linha sobrescrita GANHA o botão e a linha do app INTOCADA não
// ganha (não há entrada para remover — o handler recusaria com "no entry for
// provider"); (2) clicar e confirmar tira a entrada DO ARQUIVO em disco (lido
// aqui, não deduzido) e a linha continua na tela vinda INTEIRA da declaração do
// app, com o badge de volta em "do app"; (3) a dica da confirmação diz as duas
// coisas (o que se perde, o que volta) e não é a dica do caso sem padrão atrás;
// (4) a largura/overflow da linha a 1280px e 620px não regride com o botão a
// mais — medido com e sem ele na MESMA build, porque uma segunda build traria
// outro CSS de outras streams junto.
//
// PERFIL ISOLADO (padrão do harness): o userData do dono não é lido nem escrito.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-providers-reset-override-${CDP_PORT}`, import.meta.url).pathname;
const CONFIG_PATH = join(USER_DATA_DIR, "providers.json");

const { check, finish } = makeChecker();

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/** Sobe o app isolado. `preserveUserData` em TODOS os boots: o mesmo arquivo é
 * observado entre eles (é o caso real — editar providers.json e ver a tela).
 * `bounds` é a única escotilha real de largura de janela (o CDP do Electron não
 * implementa o domínio Browser): janela de verdade, não emulação de DOM. */
async function boot(bounds) {
  const app = await startApp({
    cdpPort: CDP_PORT,
    userDataDir: USER_DATA_DIR,
    preserveUserData: true,
    ...(bounds ? { extraEnv: { AGENT_CANVAS_TEST_WINDOW_BOUNDS: JSON.stringify(bounds) } } : {}),
  });
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  // A sessão é LIMITADA no tempo de propósito: criar sessão em janela estreita
  // (620px) é um flake CONHECIDO deste harness (o input do modal não cabe), e um
  // smoke que trava ali não mede nada. Esta página não depende da sessão para
  // existir — se ela não vier, o aviso é impresso e a medição segue.
  try {
    await Promise.race([
      bootIntoFreshSession(page, "Providers reset override"),
      delay(20000).then(() => {
        throw new Error("timeout de 20s criando a sessão (flake conhecido em janela estreita)");
      }),
    ]);
  } catch (err) {
    console.log(`[4c41368f] aviso: sessão não criada — ${String(err?.message ?? err).slice(0, 140)}`);
  }
  await delay(700);
  return { app, page };
}

/** Abre Settings → Providers (a engrenagem do rail; a página Provedores é a
 * default do modal). Seleção por título nos DOIS idiomas. */
async function openProvidersPage(page) {
  await page.evalJs(`
    (() => {
      const btn = [...document.querySelectorAll('.rail-btn')].find((b) =>
        ['Configurações', 'Settings'].includes(b.getAttribute('title') ?? ''),
      );
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  for (let i = 0; i < 40; i++) {
    if (await page.evalJs(`!!document.querySelector('.providers-settings-page [data-role="providers-row"]')`)) break;
    await delay(150);
  }
}

/** O que cada LINHA mostra e quanto ela ocupa: o botão de reset, a largura da
 * área de ações, e a overflow da linha e da página — o critério de sempre
 * ("um controle a mais não pode quebrar a linha"). */
const MEASURE_ROWS = `(() => {
  const pageEl = document.querySelector('.providers-settings-page');
  const rows = [...document.querySelectorAll('[data-role="providers-row"]')].map((row) => {
    const actions = row.querySelector('.providers-row-actions');
    const meta = row.querySelector('.providers-row-meta');
    const reset = row.querySelector('[data-role="providers-reset"]');
    const badge = row.querySelector('[data-role="providers-source-badge"]');
    return {
      id: row.getAttribute('data-provider-id'),
      badgeText: badge ? badge.textContent : null,
      hasReset: reset !== null,
      actionsWidth: actions ? actions.getBoundingClientRect().width : null,
      actionsOverflow: actions ? actions.scrollWidth - actions.clientWidth : null,
      rowOverflow: row.scrollWidth - row.clientWidth,
      metaOverflow: meta ? meta.scrollWidth - meta.clientWidth : null,
    };
  });
  return JSON.stringify({
    innerWidth: window.innerWidth,
    pageOverflow: pageEl ? pageEl.scrollWidth - pageEl.clientWidth : null,
    rows,
  });
})()`;

/** A "PROVA ANTES" na MESMA build: esconde os botões de reset que a correção
 * acrescentou (o portão antigo era `source === "file"` — ou seja, só as linhas
 * do usuário tinham botão) e re-mede. O que se compara é a linha COM e SEM o
 * controle novo, sem trocar de build. */
const HIDE_RESET_ON_APP_ROWS = `(() => {
  const hidden = [];
  for (const row of document.querySelectorAll('[data-role="providers-row"]')) {
    const badge = row.querySelector('[data-role="providers-source-badge"]');
    const reset = row.querySelector('[data-role="providers-reset"]');
    if (badge && reset) { hidden.push(row.getAttribute('data-provider-id')); reset.remove(); }
  }
  return JSON.stringify(hidden);
})()`;

// Perfil NOVO antes do primeiro boot.
rmSync(USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(USER_DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1) ARQUIVO SEM ENTRADA NENHUMA DO USUÁRIO: as duas linhas são DO APP e NÃO
//    podem ganhar botão de reset — não há entrada para remover, e o handler
//    recusaria com "no entry for provider". É a metade que a correção não pode
//    quebrar: o portão novo não é "toda linha do app", é "appOverride != none".
// ---------------------------------------------------------------------------
const first = await boot();
let published = null;
try {
  published = readConfig().appProviders;
  check("o arquivo nasceu com as declarações do app", published?.map((s) => s.id), (ids) =>
    JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );

  await openProvidersPage(first.page);
  const rows = JSON.parse(await first.page.evalJs(MEASURE_ROWS)).rows;
  check(
    "linhas do app INTOCADAS: nenhuma ganha o botão de reset",
    rows.map((r) => `${r.id}:${r.hasReset}`),
    (v) => JSON.stringify(v) === JSON.stringify(["cline:false", "commandcode:false"]),
  );
} finally {
  await stopApp(first.app);
  await delay(500);
}

// ---------------------------------------------------------------------------
// 2) AS TRÊS LINHAS NA MESMA TELA, e o reset de cada uma: a cópia INTEIRA (o
//    caso em que o app parou de corrigir), a sobrescrita PARCIAL, e o provider
//    só do usuário (que continua como sempre foi).
// ---------------------------------------------------------------------------
const CLINE_COPY = structuredClone(published.find((s) => s.id === "cline"));
CLINE_COPY.label = "Cline (cópia minha)";
// Um ajuste FUNDO, para a medida não poder ser confundida com "as chaves são
// iguais" — e para o reset ter o que descartar.
CLINE_COPY.capacity.effort.values = ["low", "medium", "high"];

// Sobrescreve o `baseArgs` — é o exemplo que a própria dica da tela cita.
const COMMANDCODE_PARTIAL = { id: "commandcode", baseArgs: ["--meu-ajuste"] };

const USER_ONLY = {
  id: "meu-cli",
  label: "Meu CLI",
  binaryNames: ["minha-cli"],
  capacity: {
    role: "agent",
    session: { canImposeSessionId: false },
    systemPrompt: { mechanism: "none" },
    mcp: { mechanism: "none" },
    acbridgeOnPath: true,
    effort: { mechanism: "none", reason: "no-flag" },
    model: { mechanism: "none", reason: "shell" },
    delivery: { briefMechanism: "positional" },
  },
};

const APP_COMMANDCODE_ARGS = published.find((s) => s.id === "commandcode").baseArgs;

function seedProviders(list) {
  const config = readConfig();
  config.providers = list;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

seedProviders([CLINE_COPY, COMMANDCODE_PARTIAL, USER_ONLY]);

const second = await boot();
try {
  const view = JSON.parse(
    await second.page.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`),
  );
  check("nenhuma entrada recusada", view.rejected?.length, 0);
  check(
    "estado de cada linha: cópia inteira / sobrescrita parcial / só do usuário",
    view.rows.map((r) => `${r.id}:${r.source}/${r.appOverride}`),
    (v) =>
      JSON.stringify(v) ===
      JSON.stringify(["cline:app/whole", "commandcode:app/partial", "meu-cli:file/none"]),
  );

  await openProvidersPage(second.page);
  const before = JSON.parse(await second.page.evalJs(MEASURE_ROWS));
  check(
    "AS DUAS SOBRESCRITAS ganham o botão de reset (era o defeito)",
    before.rows.map((r) => `${r.id}:${r.hasReset}`),
    (v) => JSON.stringify(v) === JSON.stringify(["cline:true", "commandcode:true", "meu-cli:true"]),
  );

  // --- o clique real, na linha da SOBRESCRITA PARCIAL -----------------------
  await second.page.evalJs(
    `document.querySelector('[data-provider-id="commandcode"] [data-role="providers-reset"]').click()`,
  );
  const hint = await second.page.evalJs(
    `document.querySelector('[data-provider-id="commandcode"] .providers-reset-hint')?.textContent ?? null`,
  );
  // A dica diz as DUAS coisas (ponto 3 do enunciado): o que se perde e o que
  // volta — e é a dica da sobrescrita, não a do caso sem padrão atrás.
  check("a dica nomeia o que se perde", (hint ?? "").includes("baseArgs"), true);
  check("e o que volta: a correção do app", (hint ?? "").includes("correção do app de novo"), true);
  check("e não é a dica do caso sem padrão atrás", (hint ?? "").includes("deixa de existir"), false);

  await second.page.evalJs(
    `document.querySelector('[data-provider-id="commandcode"] .providers-row-actions button.danger').click()`,
  );
  let after = JSON.parse(await second.page.evalJs(MEASURE_ROWS));
  for (let i = 0; i < 40; i++) {
    after = JSON.parse(await second.page.evalJs(MEASURE_ROWS));
    if (!after.rows.find((r) => r.id === "commandcode").hasReset) break;
    await delay(150);
  }

  // (a) A ENTRADA SAIU DO ARQUIVO — lido do disco, não deduzido.
  check(
    "a entrada do usuário saiu do providers.json (lido do disco)",
    readConfig().providers.map((p) => p.id),
    (ids) => JSON.stringify(ids) === JSON.stringify(["cline", "meu-cli"]),
  );
  // (b) O PROVIDER NÃO SUMIU: volta INTEIRO da declaração do app, com o
  //     baseArgs medido do app de novo.
  const live = JSON.parse(
    await second.page.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`),
  );
  const row = live.rows.find((r) => r.id === "commandcode");
  check("e a linha continua na tela, agora sem sobrescrita", `${row.source}/${row.appOverride}`, "app/none");
  check(
    "com o baseArgs MEDIDO do app de volta (o ajuste do usuário foi descartado)",
    JSON.stringify(row.baseArgs),
    JSON.stringify(APP_COMMANDCODE_ARGS),
  );
  check(
    "o badge da linha voltou a dizer só 'do app'",
    after.rows.find((r) => r.id === "commandcode").badgeText,
    "do app",
  );

  // --- e o mesmo na CÓPIA INTEIRA (o caso "sem correção do app") ------------
  await second.page.evalJs(
    `document.querySelector('[data-provider-id="cline"] [data-role="providers-reset"]').click()`,
  );
  await second.page.evalJs(
    `document.querySelector('[data-provider-id="cline"] .providers-row-actions button.danger').click()`,
  );
  for (let i = 0; i < 40; i++) {
    const m = JSON.parse(await second.page.evalJs(MEASURE_ROWS));
    if (!m.rows.find((r) => r.id === "cline").hasReset) break;
    await delay(150);
  }
  check(
    "a cópia inteira TAMBÉM saiu do arquivo",
    readConfig().providers.map((p) => p.id),
    (ids) => JSON.stringify(ids) === JSON.stringify(["meu-cli"]),
  );
  const live2 = JSON.parse(
    await second.page.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`),
  );
  const clineRow = live2.rows.find((r) => r.id === "cline");
  check("e cline volta a receber correção do app", `${clineRow.source}/${clineRow.appOverride}`, "app/none");
  check("com o rótulo do app de volta", clineRow.label, published.find((s) => s.id === "cline").label);
  check(
    "e o esforço congelado pela cópia deixou de valer",
    JSON.stringify(clineRow.effort?.values ?? null) !== JSON.stringify(["low", "medium", "high"]),
    true,
  );
  // O reset de uma linha não mexe na outra: a só do usuário continua lá.
  check(
    "a linha só do usuário segue intacta depois dos dois resets",
    readConfig().providers.map((p) => p.id),
    (ids) => JSON.stringify(ids) === JSON.stringify(["meu-cli"]),
  );
  second.page.close();
} finally {
  await stopApp(second.app);
  await delay(500);
}

// ---------------------------------------------------------------------------
// 3) LARGURA: o botão a mais só é aceitável se não estourar a linha. Medido a
//    1280px e 620px, COM e SEM o controle novo — e o "sem" é sonda na MESMA
//    build (esconde o botão que a correção acrescentou), porque uma build
//    "antes" traria junto o CSS de todas as outras streams.
// ---------------------------------------------------------------------------
const wide = await boot();
try {
  seedProviders([COMMANDCODE_PARTIAL, USER_ONLY]);
  await delay(1200);
  await openProvidersPage(wide.page);
  const withButton = JSON.parse(await wide.page.evalJs(MEASURE_ROWS));
  const hidden = JSON.parse(await wide.page.evalJs(HIDE_RESET_ON_APP_ROWS));
  const withoutButton = JSON.parse(await wide.page.evalJs(MEASURE_ROWS));
  console.log(
    `[4c41368f] 1280px com o botão — ${withButton.rows.map((r) => `${r.id} ações=${Math.round(r.actionsWidth)}px ov=${r.actionsOverflow}`).join(" · ")} · página ov=${withButton.pageOverflow}`,
  );
  console.log(
    `[4c41368f] 1280px sem o botão — ${withoutButton.rows.map((r) => `${r.id} ações=${Math.round(r.actionsWidth)}px ov=${r.actionsOverflow}`).join(" · ")} · página ov=${withoutButton.pageOverflow}`,
  );
  check("a sonda escondeu o botão só da linha do app", hidden, (v) => JSON.stringify(v) === JSON.stringify(["commandcode"]));
  check(
    "1280px: nada estoura com o controle novo (linha/área de ações)",
    withButton.rows.map((r) => `${r.id}:${r.actionsOverflow}/${r.rowOverflow}`),
    (v) => v.every((line) => line.endsWith(":0/0")),
  );
  check("1280px: a página não estoura", withButton.pageOverflow <= 0, true);
} finally {
  await stopApp(wide.app);
  await delay(500);
}

const narrow = await boot({ x: 0, y: 0, width: 620, height: 800 });
try {
  await openProvidersPage(narrow.page);
  const withButton = JSON.parse(await narrow.page.evalJs(MEASURE_ROWS));
  await narrow.page.evalJs(HIDE_RESET_ON_APP_ROWS);
  const withoutButton = JSON.parse(await narrow.page.evalJs(MEASURE_ROWS));
  check("620px: a janela é mesmo estreita", withButton.innerWidth < 700, true);
  console.log(
    `[4c41368f] 620px com o botão — ${withButton.rows.map((r) => `${r.id} ações=${Math.round(r.actionsWidth)}px ov=${r.actionsOverflow}`).join(" · ")} · página ov=${withButton.pageOverflow}`,
  );
  console.log(
    `[4c41368f] 620px sem o botão — ${withoutButton.rows.map((r) => `${r.id} ações=${Math.round(r.actionsWidth)}px ov=${r.actionsOverflow}`).join(" · ")} · página ov=${withoutButton.pageOverflow}`,
  );
  check(
    "620px: nada estoura na linha nem na área de ações com o controle novo",
    withButton.rows.map((r) => `${r.id}:${r.actionsOverflow}/${r.rowOverflow}`),
    (v) => v.every((line) => line.endsWith(":0/0")),
  );
  // PRÉ-EXISTENTE, e medido para não ser atribuído a esta task: a página tem 1px
  // de overflow a 620px — e ele é EXATAMENTE o mesmo com e sem o botão novo (a
  // sonda escondeu o controle na mesma build). Não é deste conserto, e a página
  // não é deste território; o que se prende aqui é que o controle novo não
  // ACRESCENTA overflow nenhum (o número não pode mudar entre os dois lados).
  console.log(
    `[4c41368f] 620px — overflow da página com/sem o controle novo: ${withButton.pageOverflow}/${withoutButton.pageOverflow}px (pré-existente, não desta task)`,
  );
  check(
    "620px: o overflow da página é o MESMO com e sem o controle novo (pré-existente, não deste conserto)",
    `${withButton.pageOverflow}/${withoutButton.pageOverflow}`,
    (v) => v.split("/")[0] === v.split("/")[1],
  );
} finally {
  await stopApp(narrow.app);
}

// Limpeza do perfil deste run — mesma escotilha de quem depura a falha.
if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });

finish();

