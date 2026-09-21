// PROVA AO VIVO (task edf3b047): o badge da linha diz as DUAS coisas — de onde
// a declaração veio E o que o usuário escreveu por cima.
//
// O defeito: uma entrada do app que o usuário sobrescreveu EM PARTE continuava
// aparecendo como "do app". O badge não mentia sobre a ORIGEM (a declaração veio
// mesmo do app), mas escondia o fato que muda o comportamento — aquela entrada
// NÃO é mais exatamente o que o app declara. Quem abre a tela para entender por
// que o commandcode sobe com uma flag estranha via "do app" e concluía que o
// responsável era o app.
//
// OS QUATRO ESTADOS, que é o que este run prova lado a lado na tela real:
//   1. só do app, intocada          -> "do app"
//   2. do app com sobrescrita       -> "do app (com ajustes seus)"
//   3. entrada só do usuário        -> sem badge de origem (como sempre foi)
//   4. entrada que copiou a declaração inteira com o mesmo id
//                                   -> "sua por inteiro (sem correção do app)"
//
// O ESTADO 4 não é "um caso a mais de ajuste": a mescla não deixa nenhum campo
// do app passar, então aquela entrada para de receber correção do app. A
// MEDIÇÃO desse comportamento (que é a justificativa do rótulo próprio) está em
// `tests/unit/providers-override-merge.test.ts` — o único lugar onde dá para
// trocar o catálogo do app por uma "versão nova" e ver a correção não chegar.
// Aqui se prova o que só o app RODANDO prova: qual estado cada entrada recebe e
// qual TEXTO sai na tela.
//
// PERFIL ISOLADO (padrão do harness): o userData do dono não é lido nem escrito.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort, bootIntoFreshSession } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-providers-origin-badge-${CDP_PORT}`, import.meta.url).pathname;
const CONFIG_PATH = join(USER_DATA_DIR, "providers.json");

const { check, finish } = makeChecker();

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/**
 * Sobe o app isolado. `preserveUserData` em TODOS os boots: o mesmo arquivo é
 * observado entre eles (é o caso real — editar `providers.json` e ver a tela),
 * e o padrão do harness apagaria o perfil no `stopApp`.
 *
 * `bounds` é a ÚNICA escotilha real de largura de janela (o CDP do Electron não
 * implementa o domínio Browser: ver `investigate-item42.mjs`), e é a mesma env
 * var que o `main` já lê para diagnóstico — janela de verdade, não emulação de
 * DOM no renderer.
 */
async function boot(bounds) {
  const app = await startApp({
    cdpPort: CDP_PORT,
    userDataDir: USER_DATA_DIR,
    preserveUserData: true,
    ...(bounds ? { extraEnv: { AGENT_CANVAS_TEST_WINDOW_BOUNDS: JSON.stringify(bounds) } } : {}),
  });
  const page = await connectPage(CDP_PORT);
  await delay(1200);
  await bootIntoFreshSession(page, "Providers origin badge");
  await delay(700);
  return { app, page };
}

/** Abre Settings → Providers (a engrenagem do rail; a página Provedores é a
 * default do modal). Seleção por título nos DOIS idiomas: o smoke não deve
 * depender do locale da máquina. */
async function openProvidersPage(page) {
  const opened = await page.evalJs(`
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
  return opened;
}

/** O que a linha MOSTRA: o texto do badge de origem, a largura dele, e a
 * overflow da linha (o critério do dono: "o badge não pode crescer a ponto de
 * quebrar a linha do provider"). */
const MEASURE = `(() => {
  const pageEl = document.querySelector('.providers-settings-page');
  const rows = [...document.querySelectorAll('[data-role="providers-row"]')].map((row) => {
    const meta = row.querySelector('.providers-row-meta');
    const badge = row.querySelector('[data-role="providers-source-badge"]');
    const rect = badge ? badge.getBoundingClientRect() : null;
    return {
      id: row.getAttribute('data-provider-id'),
      badgeText: badge ? badge.textContent : null,
      badgeWidth: rect ? Math.round(rect.width) : null,
      badgeOverflow: badge ? badge.scrollWidth - badge.clientWidth : null,
      metaOverflow: meta ? meta.scrollWidth - meta.clientWidth : null,
      metaHeight: meta ? meta.offsetHeight : null,
    };
  });
  return JSON.stringify({
    innerWidth: window.innerWidth,
    page: pageEl ? { overflow: pageEl.scrollWidth - pageEl.clientWidth } : null,
    rows,
  });
})()`;

/** As linhas que MOSTRAM badge de origem — as outras não têm texto novo para
 * medir (ver o check de largura). */
const badgedRows = (measured) => measured.rows.filter((row) => row.badgeText !== null);

// Perfil NOVO antes do primeiro boot: o primeiro caso medido é o nascimento do
// arquivo (as declarações do app publicadas em `appProviders`).
rmSync(USER_DATA_DIR, { recursive: true, force: true });
mkdirSync(USER_DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1) ARQUIVO SÓ COM A CHAVE DO USUÁRIO VAZIA: as duas linhas são DO APP e
//    NENHUMA tem sobrescrita — o vocabulário de sempre, sem parêntese.
// ---------------------------------------------------------------------------
const first = await boot();
let published = null;
try {
  check("o arquivo nasceu com as declarações do app", readConfig().appProviders?.map((s) => s.id), (ids) =>
    JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );
  published = readConfig().appProviders;

  const view = JSON.parse(
    await first.page.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`),
  );
  check("nenhuma entrada recusada", view.rejected?.length, 0);
  check(
    "as duas linhas são DO APP e sem sobrescrita",
    view.rows.map((r) => `${r.id}:${r.source}/${r.appOverride}`),
    (rows) => JSON.stringify(rows) === JSON.stringify(["cline:app/none", "commandcode:app/none"]),
  );

  await openProvidersPage(first.page);
  const measured = JSON.parse(await first.page.evalJs(MEASURE));
  check("a tela mostra o badge sem parêntese nas duas linhas", measured.rows.map((r) => r.badgeText), (texts) =>
    JSON.stringify(texts) === JSON.stringify(["do app", "do app"]),
  );
} finally {
  await stopApp(first.app);
  await delay(500);
}

// ---------------------------------------------------------------------------
// 2) OS QUATRO ESTADOS NA MESMA TELA. O estado 4 é uma CÓPIA da declaração que
//    o PRÓPRIO app publica em `appProviders` (o caminho que a receita do schema
//    convida a tomar), com um ajuste fundo em cima — para a medida não poder ser
//    confundida com "as chaves são iguais".
// ---------------------------------------------------------------------------
const CLINE_COPY = structuredClone(published.find((s) => s.id === "cline"));
CLINE_COPY.label = "Cline (cópia minha)";
CLINE_COPY.capacity.effort.values = ["low", "medium", "high"];

// Sobrescrita PARCIAL funda: `capacity` e `session` aparecem na entrada, mas só
// UM campo da sessão foi escrito — o resto continua vindo do app (e é isso que
// o badge tem de deixar de esconder).
const COMMANDCODE_PARTIAL = { id: "commandcode", capacity: { session: { resumeFlag: "--meu-flag" } } };

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

const config = readConfig();
config.providers = [CLINE_COPY, COMMANDCODE_PARTIAL, USER_ONLY];
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const second = await boot();
try {
  const view = JSON.parse(
    await second.page.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`),
  );
  check("a cópia inteira e a parcial NÃO são recusadas", view.rejected?.length, 0);

  // O CAMPO PROJETADO, por linha: é o main que decide (a mesma mescla que o
  // loader usa), não a tela.
  check(
    "estado de cada linha: cópia inteira / sobrescrita parcial / só do usuário",
    view.rows.map((r) => `${r.id}:${r.source}/${r.appOverride}`),
    (rows) =>
      JSON.stringify(rows) ===
      JSON.stringify(["cline:app/whole", "commandcode:app/partial", "meu-cli:file/none"]),
  );
  // A parcial é FUNDA e continua parcial: `capacity` e `session` estão na
  // entrada, mas o resto do `capacity` não — quem cobrasse só o nível de cima
  // diria "whole" aqui.
  check(
    "a entrada parcial mantém os campos que o app declara (o def é a MESCLA)",
    view.rows.find((r) => r.id === "commandcode")?.baseArgs,
    (args) => JSON.stringify(args) === JSON.stringify(["--yolo", "--skip-onboarding"]),
  );
  check(
    "e o campo que ela escreveu venceu",
    view.rows.find((r) => r.id === "commandcode")?.label,
    "Command Code",
  );

  await openProvidersPage(second.page);
  const wide = JSON.parse(await second.page.evalJs(MEASURE));
  check(
    "a tela: cópia inteira / com ajustes seus / sem badge",
    wide.rows.map((r) => `${r.id}: ${r.badgeText}`),
    (texts) =>
      JSON.stringify(texts) ===
      JSON.stringify([
        "cline: sua por inteiro (sem correção do app)",
        "commandcode: do app (com ajustes seus)",
        "meu-cli: null",
      ]),
  );
  // O que a tarefa pediu para medir: o badge não pode crescer a ponto de
  // quebrar a linha. A largura medida vai no log (é o número do relatório); o
  // check é que NÃO há overflow novo — nem na linha, nem dentro do badge.
  // Só as linhas COM badge de origem entram no check: a do usuário não ganha
  // badge nenhum, e o overflow dela (medido antes desta task, no mesmo
  // harness) é de outro dono.
  console.log(
    `[edf3b047] 1280px — ${wide.rows.map((r) => `${r.id} badge=${r.badgeWidth ?? "-"}px meta=${r.metaHeight}px`).join(" · ")}`,
  );
  check(
    "1280px: sem overflow na linha nem no badge",
    badgedRows(wide).map((r) => `${r.id}:${r.metaOverflow}/${r.badgeOverflow}`),
    (values) => values.every((v) => v.endsWith(":0/0")),
  );
  check(
    "1280px: o badge mais largo é o da cópia inteira",
    wide.rows.map((r) => `${r.id}:${r.badgeWidth}`).join(" "),
    (line) => line.includes("cline:") && wide.rows[0].badgeWidth > wide.rows[1].badgeWidth,
  );
} finally {
  await stopApp(second.app);
  await delay(500);
}

// ---------------------------------------------------------------------------
// 3) JANELA ESTREITA (620px): o mesmo arquivo, o caso em que a .form-row do
//    modal encolhe e a linha do provider tem menos espaço. Medido ANTES desta
//    task no mesmo harness: 0 de overflow na linha e no badge, e os badges
//    "do app" (49px) / "sobe sem pedir permissão" (141px). O que se cobra é que
//    o texto novo não INTRODUZA overflow — a linha pode passar a ocupar mais
//    altura (a .providers-row-meta já quebra), nunca estourar a largura.
// ---------------------------------------------------------------------------
const third = await boot({ x: 0, y: 0, width: 620, height: 800 });
try {
  await openProvidersPage(third.page);
  const narrow = JSON.parse(await third.page.evalJs(MEASURE));
  console.log(
    `[edf3b047] 620px — ${narrow.rows.map((r) => `${r.id} badge=${r.badgeWidth ?? "-"}px meta=${r.metaHeight}px`).join(" · ")}`,
  );
  check("620px: a janela é mesmo estreita", narrow.innerWidth < 700, true);
  check(
    "620px: sem overflow na linha nem no badge (a linha pode ficar mais ALTA)",
    badgedRows(narrow).map((r) => `${r.id}:${r.metaOverflow}/${r.badgeOverflow}`),
    (values) => values.every((v) => v.endsWith(":0/0")),
  );
  check(
    "620px: os três textos continuam inteiros (nada truncado)",
    narrow.rows.map((r) => r.badgeText),
    (texts) => texts[0] === "sua por inteiro (sem correção do app)" && texts[1] === "do app (com ajustes seus)",
  );
} finally {
  await stopApp(third.app);
}

// Limpeza do perfil deste run — mesma escotilha de quem está depurando
// (`VERIFY_KEEP_USERDATA=1` deixa o perfil como evidência).
if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });

finish();
