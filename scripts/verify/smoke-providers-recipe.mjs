// PROVA AO VIVO (task 49796d45, atualizada na 3fe0db6e): o que o usuário
// ENCONTRA e o que ele CONSEGUE FAZER quando clica em "editar".
//
// Perfil ISOLADO (padrão do harness): o userData do dono não é lido nem escrito.
//
// O QUE ESTE SMOKE PROVA, e por que não é teste unitário: os dois checks
// centrais são cruzados e de comportamento —
//   1) a declaração publicada NO ARQUIVO (`appProviders`) tem de ser IGUAL ao
//      que o app de fato usa, lido pela própria visão do app
//      (`window.system.readProvidersConfig()`, a mesma que a tela consome);
//   2) a promessa da dica da tela (`"baseArgs": []` remove) tem de ser
//      cumprida pelo app RODANDO — antes desta task a mesma entrada era
//      recusada, ou seja, a tela prometia o que o loader não cumpria.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-providers-recipe-${CDP_PORT}`, import.meta.url).pathname;
const CONFIG_PATH = join(USER_DATA_DIR, "providers.json");
const SCHEMA_PATH = join(USER_DATA_DIR, "providers.schema.json");

const { check, finish } = makeChecker();

/** Perfil NOVO no primeiro boot; preservado entre os boots deste run (é o MESMO
 * arquivo sendo observado antes e depois de cada um). `preserveUserData` em
 * todos: o padrão do harness apaga o perfil no `stopApp`. */
rmSync(USER_DATA_DIR, { recursive: true, force: true });
async function boot() {
  const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, preserveUserData: true });
  const page = await connectPage(CDP_PORT);
  return { app, page };
}

const { app, page } = await boot();
try {
  // -----------------------------------------------------------------------
  // 1) O usuário clica em "editar": o arquivo dele e o schema ao lado.
  // -----------------------------------------------------------------------
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  check("o arquivo aponta para o schema ao lado", config.$schema, "./providers.schema.json");
  check("a referência resolve num arquivo que existe no disco", existsSync(join(USER_DATA_DIR, config.$schema)), true);

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const examples = schema.properties?.providers?.items?.examples;
  check("o schema publica a receita (examples)", Array.isArray(examples), true);
  check(
    "a receita são os dois CLIs que já vêm prontos",
    examples?.map((spec) => spec.id),
    (ids) => JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );
  check(
    "a receita do commandcode carrega as flags medidas (o --yolo e o --skip-onboarding)",
    examples?.find((spec) => spec.id === "commandcode")?.baseArgs,
    (args) => JSON.stringify(args) === JSON.stringify(["--yolo", "--skip-onboarding"]),
  );

  // O AVISO (task 3fe0db6e): agora que as duas chaves existem, o jeito certo é
  // SOBRESCREVER UM CAMPO — ninguém precisa copiar declaração inteira (e copiar
  // era o caso (D) medido: a cópia congela e para de receber correção).
  const providersDescription = schema.properties?.providers?.description ?? "";
  check("o texto ensina a SOBRESCREVER um campo", providersDescription.includes("SOBRESCRITA"), true);
  check("e diz que arrays SUBSTITUEM (a promessa da dica da tela)", providersDescription.includes("SUBSTITUEM"), true);
  check(
    "e nomeia a chave do app como sendo do app",
    (schema.properties?.appProviders?.description ?? "").includes("DO APP"),
    true,
  );

  // -----------------------------------------------------------------------
  // 2) A RECEITA ESTÁ NO ARQUIVO DO USUÁRIO, na chave do APP — e a chave DELE
  //    continua vazia (é o que preserva a posse: o app não escreve no que é seu).
  // -----------------------------------------------------------------------
  check(
    "a lista do app está no arquivo, completa",
    config.appProviders?.map((spec) => spec.id),
    (ids) => JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );
  check("a chave DO USUÁRIO continua vazia (o app não escreve nela)", JSON.stringify(config.providers), "[]");

  // -----------------------------------------------------------------------
  // 3) O CRUZAMENTO: o que está publicado no arquivo == o que o APP usa.
  // -----------------------------------------------------------------------
  const view = JSON.parse(
    await page.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`),
  );
  check("o app leu o arquivo do usuário sem erro", view.error, null);
  check("e não recusou nenhuma entrada", view.rejected?.length, 0);
  const shippedRows = view.rows.filter((row) => row.source === "app");
  check(
    "os dois CLIs aparecem como DO APP (o mesmo vocabulário do badge da tela)",
    shippedRows.map((row) => row.id),
    (ids) => JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );

  for (const id of ["cline", "commandcode"]) {
    const publicado = config.appProviders.find((spec) => spec.id === id);
    const live = shippedRows.find((row) => row.id === id);
    check(
      `a declaração publicada de ${id} == o que o app spawna (baseArgs)`,
      JSON.stringify({ publicado: publicado?.baseArgs ?? [], live: live?.baseArgs ?? [] }),
      (pair) => JSON.parse(pair).publicado.join(" ") === JSON.parse(pair).live.join(" "),
    );
    // E o binário também: receita que diz um binário e o app usando outro
    // seria a receita mentindo sobre o essencial.
    check(
      `a declaração publicada de ${id} == o que o app spawna (binários)`,
      JSON.stringify({ publicado: publicado?.binaryNames ?? [], live: live?.binaryNames ?? [] }),
      (pair) => JSON.parse(pair).publicado.join(",") === JSON.parse(pair).live.join(","),
    );
    check(`a declaração publicada de ${id} bate com o rótulo que a UI mostra`, publicado?.label, live?.label);
  }

  page.close();
} finally {
  await stopApp(app);
}

// -------------------------------------------------------------------------
// 2) A PROMESSA DA DICA DA TELA, no app: `"baseArgs": []` remove as flags — e
//    o que NÃO foi escrito continua vindo do app. Antes desta task a mesma
//    entrada era RECUSADA (medido: "`label` must be a non-empty string"), ou
//    seja: a tela prometia o que o loader não cumpria.
// -------------------------------------------------------------------------
const { app: secondApp, page: secondPage } = await boot();
try {
  // Escreve a sobrescrita parcial COM O APP JÁ RODANDO: é o gesto real (editar
  // o arquivo e ver a tela refletir), e é o caminho do watcher.
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  config.providers = [{ id: "commandcode", baseArgs: [] }];
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  let view = null;
  for (let i = 0; i < 60; i++) {
    view = JSON.parse(await secondPage.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`));
    const row = view.rows.find((r) => r.id === "commandcode");
    if (row && JSON.stringify(row.baseArgs) === "[]") break;
    await delay(150);
  }
  const row = view.rows.find((r) => r.id === "commandcode");
  check("a sobrescrita parcial NÃO é recusada", view.rejected?.length, 0);
  check("a dica da tela é cumprida: baseArgs vazio no provider", JSON.stringify(row?.baseArgs), "[]");
  // A ORIGEM continua sendo o app — a entrada do usuário só ajustou um campo.
  check("e a linha continua sendo DO APP (a origem é a chave, não um campo)", row?.source, "app");
  // O que o usuário NÃO escreveu continua vindo do app (a mescla preservou).
  check("o rótulo e o binário continuam os do app", JSON.stringify([row?.label, row?.binaryNames?.[0]]), (v) =>
    JSON.parse(v)[0] === "Command Code" && JSON.parse(v)[1] === "commandcode",
  );
  secondPage.close();
} finally {
  await stopApp(secondApp);
}

// Limpeza do perfil deste run — mesmo contrato do harness, com a mesma
// escotilha de quem está depurando uma falha (o perfil é a evidência).
if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });

finish();
