// PROVA AO VIVO (task 49796d45): o que o usuário ENCONTRA quando clica em
// "editar" — a receita dos dois CLIs que já funcionam, sem que ela vire fonte.
//
// Perfil ISOLADO (padrão do harness): o userData do dono não é lido nem escrito.
//
// O QUE ESTE SMOKE PROVA, e por que não é teste unitário: o check central é
// cruzado — a receita publicada no `providers.schema.json` em DISCO tem de ser
// IGUAL ao que o app de fato usa, lido pela própria visão do app
// (`window.system.readProvidersConfig()`, a mesma que a tela de Settings
// consome). Teste unitário prova que a receita deriva das specs; só o app
// rodando prova que a receita publicada e o comportamento vivo são a MESMA
// coisa — e foi um teste verde que escondeu a ausência de chamador por semanas.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-providers-recipe-${CDP_PORT}`, import.meta.url).pathname;
const CONFIG_PATH = join(USER_DATA_DIR, "providers.json");
const SCHEMA_PATH = join(USER_DATA_DIR, "providers.schema.json");

const { check, finish } = makeChecker();

const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR });
try {
  const page = await connectPage(CDP_PORT);

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

  // O AVISO (item 3 do brief): copiar cria entrada de usuário que VENCE a
  // embutida — o caso (D) medido na task d9aa8b1a.
  const warning = `${schema.properties?.providers?.description ?? ""} ${schema.properties?.providers?.items?.description ?? ""}`;
  check("o texto AVISA que a cópia vence a embutida", warning.includes("VENCE"), true);
  check("e diz que para USAR não precisa copiar", warning.includes("não precisa copiar"), true);

  // -----------------------------------------------------------------------
  // 2) A RECEITA NÃO VIROU ESTADO: o `providers` do usuário continua vazio, e
  //    a receita não é injetada lá (é o que preserva os três níveis).
  // -----------------------------------------------------------------------
  check("o providers do usuário continua vazio (receita não é estado)", JSON.stringify(config.providers), "[]");
  check("e não ganhou uma chave de receita própria", "examples" in config, false);

  // -----------------------------------------------------------------------
  // 3) O CRUZAMENTO: a receita publicada == o que o APP usa.
  // -----------------------------------------------------------------------
  const view = JSON.parse(
    await page.evalJs(`(async () => JSON.stringify(await window.system.readProvidersConfig()))()`),
  );
  check("o app leu o arquivo do usuário sem erro", view.error, null);
  const shippedRows = view.rows.filter((row) => row.source === "app");
  check(
    "os dois CLIs estão registrados como EMBUTIDOS (camada shipped, não arquivo)",
    shippedRows.map((row) => row.id),
    (ids) => JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );

  for (const id of ["cline", "commandcode"]) {
    const recipe = examples.find((spec) => spec.id === id);
    const live = shippedRows.find((row) => row.id === id);
    check(
      `receita de ${id} == o que o app spawna (baseArgs)`,
      JSON.stringify({ recipe: recipe?.baseArgs ?? [], live: live?.baseArgs ?? [] }),
      (pair) => JSON.parse(pair).recipe.join(" ") === JSON.parse(pair).live.join(" "),
    );
    // E o binário também: receita que diz um binário e o app usando outro
    // seria a receita mentindo sobre o essencial.
    check(
      `receita de ${id} == o que o app spawna (binários)`,
      JSON.stringify({ recipe: recipe?.binaryNames ?? [], live: live?.binaryNames ?? [] }),
      (pair) => JSON.parse(pair).recipe.join(",") === JSON.parse(pair).live.join(","),
    );
    check(`receita de ${id} bate com o rótulo que a UI mostra`, recipe?.label, live?.label);
  }

  page.close();
} finally {
  await stopApp(app);
}
finish();
