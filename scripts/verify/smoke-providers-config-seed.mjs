// PROVA AO VIVO (task d9aa8b1a): o `providers.json` do usuário NASCE instruído
// e um arquivo pobre — o do dono, 44 bytes — é COMPLETADO no boot.
//
// SEMPRE em perfil isolado (`--user-data-dir` próprio, via cdp-client): o
// userData do dono não é lido nem escrito. O que este run prova é justamente o
// que prova nenhuma de teste unitário provou: o app de VERDADE sobe e o efeito
// aparece no DISCO.
//
// Por que isto existe além de `tests/unit/providers-config-seed.test.ts`: o
// defeito original foi uma função exportada, documentada e testada — chamada só
// pelos próprios testes — sem nenhum chamador de produção. Teste verde com
// chamada direta não distingue "ligado" de "desligado"; subir o app distingue.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startApp, stopApp, connectPage, makeChecker, pickFreePort } from "./cdp-client.mjs";

const CDP_PORT = await pickFreePort();
const USER_DATA_DIR = new URL(`../../.verify-tmp/smoke-providers-seed-${CDP_PORT}`, import.meta.url).pathname;
const CONFIG_PATH = join(USER_DATA_DIR, "providers.json");
const SCHEMA_PATH = join(USER_DATA_DIR, "providers.schema.json");

const { check, finish } = makeChecker();

/** O arquivo EXATO que o dono encontrou ao clicar em "editar": 44 bytes, sem
 * `$schema` e sem exemplo. */
const POOR_FILE = `{ "schemaVersion": 1, "providers": [] }`;

/** Um provider de usuário, para provar que a migração PRESERVA o que ele escreveu. */
const USER_PROVIDER = {
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

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/** Sobe o app isolado e espera a janela principal responder.
 *
 * `preserveUserData: true` em TODOS os boots, inclusive o primeiro: o padrão do
 * harness é apagar o perfil no `stopApp`, e este smoke PRECISA do perfil vivo
 * entre os três boots (é o mesmo arquivo sendo observado antes e depois de cada
 * um). O perfil deste run é removido no fim, aqui embaixo, com a mesma escotilha
 * `VERIFY_KEEP_USERDATA` do harness.
 *
 * O LOG é a UNIÃO do stdout capturado aqui com o stderr que o próprio harness
 * guarda (`app.stderr()`), e a razão é medida: o harness já registra um listener
 * em `stderr` dentro do `startApp`, e um listener `data` que chega DEPOIS não
 * recebe o que já foi lido — foi assim que a linha de `console.warn` (stderr)
 * desapareceu deste script enquanto as de `console.info` (stdout, sem leitor
 * concorrente) apareciam. O bug estava na sonda, não no app. */
async function boot() {
  const app = await startApp({ cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, preserveUserData: true });
  let stdout = "";
  app.proc.stdout?.on("data", (d) => (stdout += d.toString()));
  const page = await connectPage(CDP_PORT);
  return { app, page, log: () => stdout + app.stderr() };
}

// Perfil NOVO antes do primeiro boot: o caso medido é o nascimento, então não
// pode haver resíduo de um run anterior (o `preserveUserData` acima não limpa).
rmSync(USER_DATA_DIR, { recursive: true, force: true });

/**
 * Espera a linha aparecer no log do main. O CDP responde ANTES de o boot
 * terminar de escrever no stdout — medido: a primeira versão deste script
 * lia o log curto demais e via vazio (o mesmo motivo pelo qual um smoke que
 * não espera vira um falso negativo sobre a sonda, não sobre o produto).
 */
async function waitForLog(run, needle, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (run.log().includes(needle)) return true;
    if (Date.now() > deadline) return false;
    await delay(100);
  }
}

const first = await boot();
try {
  // -----------------------------------------------------------------------
  // 1) NASCIMENTO: perfil novo, sem `providers.json` nenhum.
  // -----------------------------------------------------------------------
  check("providers.json existe depois do boot", existsSync(CONFIG_PATH), true);
  const born = readConfig();
  check("nasceu com $schema", born.$schema, "./providers.schema.json");
  check("nasceu com schemaVersion 1", born.schemaVersion, 1);
  // A CHAVE DO USUÁRIO nasce VAZIA — e é ela que o app nunca escreve.
  check("nasceu com a chave do usuário vazia", Array.isArray(born.providers) && born.providers.length, 0);
  // A DO APP nasce completa e VISÍVEL: é o que responde "o que este app entrega
  // pronto?" no arquivo que o dono abre (a pergunta dele: "cadê a unicidade?").
  check("nasceu com a lista do app completa", born.appProviders?.map((s) => s.id), (ids) =>
    JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );
  check("o _example fictício NÃO é mais escrito", "_example" in born, false);

  // O ponto do `$schema` RELATIVO: o editor resolve offline, ao lado do
  // arquivo. Se o caminho publicado não existir no disco, não há autocompletar.
  check("o $schema publicado resolve num arquivo que existe", existsSync(join(USER_DATA_DIR, born.$schema)), true);
  check("o schema ao lado foi publicado", existsSync(SCHEMA_PATH), true);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  check("o schema é o JSON Schema 2020-12", schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  check("o schema descreve o providers.json", typeof schema.title === "string" && schema.title.includes("providers.json"), true);
  // As duas chaves, com DONO explícito — é o que torna o arquivo
  // autoexplicativo para quem nunca viu este repo (exigência 3 do aceite).
  check("o schema diz que `providers` é do usuário", schema.properties.providers.description.includes("SUA lista"), true);
  check("o schema diz que `appProviders` é do app", schema.properties.appProviders.description.includes("DO APP"), true);

  // O MESMO caminho que o botão "editar" usa no app (IPC), não uma cópia nossa.
  const pathFromApp = await first.page.evalJs(`window.system.getProvidersConfigPath()`);
  check("o app aponta para o MESMO arquivo que eu li", pathFromApp, CONFIG_PATH);
  check("o boot relatou o nascimento", await waitForLog(first, "criado com a lista do app em `appProviders`"), true);
} finally {
  await stopApp(first.app);
}

// -------------------------------------------------------------------------
// 2) O CASO DO DONO: arquivo já existe, pobre, e COM conteúdo dele dentro —
//    inclusive uma declaração INTEIRA já copiada para `providers` (a migração
//    não pode perdê-la, e ela continua vencendo: caso degenerado da parcial).
// -------------------------------------------------------------------------
const COPIA_INTEIRA = {
  id: "commandcode",
  label: "Cópia antiga do dono",
  binaryNames: ["commandcode"],
  baseArgs: ["--meu-jeito"],
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
writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    { ...JSON.parse(POOR_FILE), providers: [USER_PROVIDER, COPIA_INTEIRA], _minhasNotas: "não apague" },
    null,
    2,
  ) + "\n",
  "utf8",
);
const second = await boot();
try {
  const migrated = readConfig();
  check("foi COMPLETADO com $schema", migrated.$schema, "./providers.schema.json");
  check("ganhou a lista do app", migrated.appProviders?.map((s) => s.id), (ids) =>
    JSON.stringify(ids) === JSON.stringify(["cline", "commandcode"]),
  );
  // A parte que protege o trabalho do usuário: NADA dele foi perdido — nem a
  // declaração inteira que ele tinha copiado.
  check("o provider do usuário ficou intacto", migrated.providers?.[0], (p) =>
    JSON.stringify(p) === JSON.stringify(USER_PROVIDER),
  );
  check("a declaração INTEIRA copiada ficou intacta", migrated.providers?.[1], (p) =>
    JSON.stringify(p) === JSON.stringify(COPIA_INTEIRA),
  );
  check("a chave de notas do usuário ficou intacta", migrated._minhasNotas, "não apague");
  check("o boot relatou a atualização", await waitForLog(second, "atualizei a lista do app em `appProviders`"), true);
} finally {
  await stopApp(second.app);
}

// -------------------------------------------------------------------------
// 3) ARQUIVO QUEBRADO não é tocado: o app não "conserta" o trabalho de quem
//    estava no meio de uma edição — reporta e deixa como está.
// -------------------------------------------------------------------------
const BROKEN = `{ "schemaVersion": 1, "providers": [ { "id": "meu" `;
writeFileSync(CONFIG_PATH, BROKEN, "utf8");
const third = await boot();
try {
  check("JSON quebrado continua BYTE A BYTE como estava", readFileSync(CONFIG_PATH, "utf8"), BROKEN);
  check("e o boot DISSE que não tocou", await waitForLog(third, "NÃO toquei no arquivo"), true);
} finally {
  await stopApp(third.app);
}

// Limpeza do perfil deste run — mesmo contrato do harness, com a mesma escotilha
// de quem está depurando uma falha (o perfil é a evidência).
if (process.env.VERIFY_KEEP_USERDATA !== "1") rmSync(USER_DATA_DIR, { recursive: true, force: true });

finish();
