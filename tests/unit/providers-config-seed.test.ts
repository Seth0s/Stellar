import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDERS_CONFIG_EXAMPLE,
  PROVIDERS_CONFIG_SCHEMA_VERSION,
  PROVIDERS_INSTRUCTION_KEYS,
  PROVIDERS_SCHEMA_FILENAME,
  bootstrapProvidersConfig,
  ensureProvidersConfigFile,
  initialProvidersConfig,
  parseProviderSpec,
  parseProviderSpecs,
  planProvidersSeed,
  providersConfigPath,
  providersSchemaPath,
} from "../../src/main/providers-dynamic";

/**
 * O ARQUIVO DO USUÁRIO NASCE INSTRUÍDO — e quem garante isso tem CHAMADOR
 * (task d9aa8b1a).
 *
 * O relato do dono, no build novo: "o schema não está no providers.json, eu fui
 * clicar para editar; o cline e o commandcode não estão, e não tem o schema e
 * explicação nele". A causa medida foi FIAÇÃO: `initialProvidersConfig` e
 * `ensureProvidersSchemaFile` existiam desde a 64aed52b, documentadas, testadas
 * — e sem um único chamador de produção. O arquivo real tinha 44 bytes
 * (`{ "schemaVersion": 1, "providers": [] }`), exatamente o caso que a primeira
 * foi escrita para evitar.
 *
 * POR ISSO O ÚLTIMO BLOCO DESTE ARQUIVO NÃO TESTA COMPORTAMENTO: ele pergunta
 * "alguém chama isto?". Foi a pergunta que faltava — teste verde chamando a
 * função direto, `tsc` calado porque ela é exportada, e revisão aprovando o
 * desenho certo que não estava ligado. Um gate que só olha comportamento não
 * pega uma função sem chamador, e é essa a classe de falha que este arquivo
 * trava.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-providers-seed-"));
  dirs.push(dir);
  return dir;
}

/** O arquivo exato que o dono tinha em disco — 44 bytes, sem instrução. */
const POOR_FILE = `{ "schemaVersion": 1, "providers": [] }`;

describe("planProvidersSeed — só acrescenta o que FALTA (decisão pura)", () => {
  it("arquivo pobre ganha as duas chaves, com `$schema` abrindo e `_example` fechando", () => {
    const plan = planProvidersSeed({ schemaVersion: 1, providers: [] });

    expect(plan.addedKeys).toEqual(["$schema", "_example"]);
    expect(Object.keys(plan.next)).toEqual(["$schema", "schemaVersion", "providers", "_example"]);
    expect(plan.next.$schema).toBe(initialProvidersConfig().$schema);
    expect(plan.next._example).toEqual(PROVIDERS_CONFIG_EXAMPLE);
  });

  it("só o que falta: um `$schema` próprio do usuário é PRESERVADO e o `_example` entra", () => {
    const plan = planProvidersSeed({ schemaVersion: 1, providers: [], $schema: "./meu-schema.json" });

    expect(plan.addedKeys).toEqual(["_example"]);
    expect(plan.next.$schema).toBe("./meu-schema.json");
  });

  it("um `_example` reescrito como bloco de notas do usuário é PRESERVADO", () => {
    const notas = { minhas: "notas" };
    const plan = planProvidersSeed({ schemaVersion: 1, providers: [], _example: notas });

    expect(plan.addedKeys).toEqual(["$schema"]);
    expect(plan.next._example).toBe(notas);
    // `$schema` entra na frente; o resto mantém a ordem do usuário.
    expect(Object.keys(plan.next)).toEqual(["$schema", "schemaVersion", "providers", "_example"]);
  });

  it("arquivo já completo não é tocado: nenhuma chave e o MESMO objeto", () => {
    const raw = { $schema: "./x.json", schemaVersion: 1, providers: [], _example: {} };
    const plan = planProvidersSeed(raw);

    expect(plan.addedKeys).toEqual([]);
    expect(plan.next).toBe(raw);
  });

  it("`providers` nunca é reescrito, nem reordenado, nem filtrado", () => {
    const providers = [{ id: "meu", nota: "declaração quebrada de propósito, é do usuário" }];
    const plan = planProvidersSeed({ schemaVersion: 1, providers });

    expect(plan.next.providers).toBe(providers);
  });

  it("as chaves de instrução que o app acrescenta são exatamente as que ele publica", () => {
    expect(PROVIDERS_INSTRUCTION_KEYS).toEqual(["$schema", "_example"]);
    const seed = initialProvidersConfig();
    for (const key of PROVIDERS_INSTRUCTION_KEYS) expect(seed).toHaveProperty(key);
  });
});

describe("ensureProvidersConfigFile — nascimento, migração e o que NÃO é tocado", () => {
  it("arquivo ausente NASCE instruído, e o que nasce passa pelo validador do loader", () => {
    const dir = freshDir();
    const result = ensureProvidersConfigFile(dir);

    expect(result.action).toBe("created");
    expect(result.error).toBeNull();

    const text = readFileSync(providersConfigPath(dir), "utf8");
    const written = JSON.parse(text);
    expect(written.$schema).toBe("./providers.schema.json");
    expect(written._example).toEqual(PROVIDERS_CONFIG_EXAMPLE);
    // O mesmo validador que o loader usa — o arquivo semeado não pode precisar
    // de tratamento especial (senão a instrução ensinaria um formato que o
    // parser recusa).
    expect(parseProviderSpecs(written)).toEqual({ specs: [], rejected: [] });
    // E o exemplo de dentro é um spec VÁLIDO de verdade.
    expect(parseProviderSpec(PROVIDERS_CONFIG_EXAMPLE).ok).toBe(true);
  });

  it("o arquivo pobre do dono (44 bytes) é COMPLETADO — e `providers` fica intacto", () => {
    const dir = freshDir();
    writeFileSync(providersConfigPath(dir), POOR_FILE, "utf8");

    const result = ensureProvidersConfigFile(dir);
    expect(result.action).toBe("migrated");
    expect(result.addedKeys).toEqual(["$schema", "_example"]);

    const written = JSON.parse(readFileSync(providersConfigPath(dir), "utf8"));
    expect(written.$schema).toBe("./providers.schema.json");
    expect(written.schemaVersion).toBe(PROVIDERS_CONFIG_SCHEMA_VERSION);
    expect(written.providers).toEqual([]);
    expect(written._example).toEqual(PROVIDERS_CONFIG_EXAMPLE);
  });

  it("migra um arquivo com provider do usuário preservando a declaração dele", () => {
    const dir = freshDir();
    const doUsuario = {
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
    writeFileSync(
      providersConfigPath(dir),
      JSON.stringify({ schemaVersion: 1, providers: [doUsuario], _nota: "chave minha" }, null, 2),
      "utf8",
    );

    const result = ensureProvidersConfigFile(dir);
    expect(result.action).toBe("migrated");
    expect(result.addedKeys).toEqual(["$schema", "_example"]);

    const written = JSON.parse(readFileSync(providersConfigPath(dir), "utf8"));
    expect(written.providers).toEqual([doUsuario]);
    // Chave desconhecida é do usuário (o schema não proíbe extras de propósito).
    expect(written._nota).toBe("chave minha");
    // E o arquivo migrado continua sendo declaração válida para o loader.
    expect(parseProviderSpecs(written).specs.map((s) => s.id)).toEqual(["meu-cli"]);
  });

  it("já completo é `unchanged`: nada é escrito (nem o mtime muda)", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir);
    const before = readFileSync(providersConfigPath(dir), "utf8");
    const beforeMtime = statSync(providersConfigPath(dir)).mtimeMs;

    const result = ensureProvidersConfigFile(dir);
    expect(result.action).toBe("unchanged");
    expect(result.addedKeys).toEqual([]);
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(before);
    expect(statSync(providersConfigPath(dir)).mtimeMs).toBe(beforeMtime);
  });

  it("JSON QUEBRADO não é tocado nem consertado — o trabalho do usuário é dele", () => {
    const dir = freshDir();
    const broken = `{ "schemaVersion": 1, "providers": [ { "id": "meu" `;
    writeFileSync(providersConfigPath(dir), broken, "utf8");

    const result = ensureProvidersConfigFile(dir);
    expect(result.action).toBe("invalid");
    expect(result.error).toContain("not valid JSON");
    // Byte a byte: nem "quase válido", nem reformatado.
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(broken);
  });

  it("raiz que não é objeto também é `invalid` e intocada", () => {
    const dir = freshDir();
    writeFileSync(providersConfigPath(dir), "[1, 2, 3]", "utf8");

    const result = ensureProvidersConfigFile(dir);
    expect(result.action).toBe("invalid");
    expect(result.error).toContain("not a JSON object");
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe("[1, 2, 3]");
  });

  it("arquivo ausente volta a nascer: apagar não é um estado a preservar", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir);
    rmSync(providersConfigPath(dir));

    expect(ensureProvidersConfigFile(dir).action).toBe("created");
    expect(JSON.parse(readFileSync(providersConfigPath(dir), "utf8")).$schema).toBe("./providers.schema.json");
  });
});

describe("bootstrapProvidersConfig — o passo de boot, e o `$schema` que o editor resolve", () => {
  it("publica o schema ao lado E semeia o arquivo, com a referência RELATIVA resolvendo no disco", () => {
    const dir = freshDir();
    const result = bootstrapProvidersConfig(dir);

    expect(result.schema.written).toBe(true);
    expect(result.config.action).toBe("created");

    const ref = (JSON.parse(readFileSync(providersConfigPath(dir), "utf8")) as { $schema: string }).$schema;
    // O ponto inteiro do `$schema` relativo: o editor resolve offline, ao lado
    // do arquivo. Se o caminho publicado não existir, não há autocompletar.
    expect(ref).toBe(`./${PROVIDERS_SCHEMA_FILENAME}`);
    const schema = JSON.parse(readFileSync(providersSchemaPath(dir), "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toContain("providers.json");
  });

  it("é idempotente: o segundo boot não reescreve nem o schema nem o arquivo", () => {
    const dir = freshDir();
    bootstrapProvidersConfig(dir);
    const second = bootstrapProvidersConfig(dir);

    expect(second.schema.written).toBe(false);
    expect(second.config.action).toBe("unchanged");
    expect(second.config.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// O GATE DE FIAÇÃO — a pergunta que faltava.
//
// Uma função exportada, com teste verde e sem chamador, atravessa `tsc`, o
// `vitest` e a revisão. Foi o que aconteceu aqui: o desenho existia desde a
// 64aed52b e o arquivo do usuário continuava com 44 bytes. Estes testes leem o
// ponto de fiação (`src/main/index.ts`) e falham se ele desaparecer.
//
// O que eles NÃO são: prova de que a fiação FUNCIONA em runtime — isso um teste
// de texto não pode dar. A prova de efeito é o smoke isolado
// (`scripts/verify/smoke-providers-config-seed.mjs`), que sobe o app de
// verdade e lê o arquivo do disco. Os dois se completam: aqui é barato e roda
// com o resto da suíte; lá é caro e prova o efeito.
// ---------------------------------------------------------------------------
describe("fiação de produção — alguém CHAMA isto?", () => {
  const indexSource = readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  // Sem comentários: os gates abaixo procuram CÓDIGO, e este arquivo tem um
  // comentário que CITA a chamada antiga (`writeProvidersConfig(path, {}, [])`)
  // justamente para explicar por que ela saiu — ele não pode contar como
  // violação, do mesmo jeito que um comentário que cite a chamada nova não
  // pode contar como fiação.
  const indexCode = indexSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  function importedFromProvidersDynamic(symbol: string): boolean {
    const match = /import\s*\{([\s\S]*?)\}\s*from\s*"\.\/providers-dynamic";/.exec(indexCode);
    if (match === null) return false;
    return match[1]
      .split(",")
      .map((entry) => entry.replace(/\/\/.*$/gm, "").trim())
      .some((entry) => entry === symbol || entry === `type ${symbol}`);
  }

  it("o boot chama `bootstrapProvidersConfig` (é o passo que faz o arquivo existir instruído)", () => {
    expect(importedFromProvidersDynamic("bootstrapProvidersConfig")).toBe(true);
    expect(indexCode).toMatch(/bootstrapProvidersConfig\(\s*newUserData\s*\)/);
  });

  it("o caminho de 'abrir no editor' usa a MESMA semeadura, não uma segunda escrita", () => {
    expect(importedFromProvidersDynamic("ensureProvidersConfigFile")).toBe(true);
    expect(indexCode).toMatch(/ensureProvidersConfigFile\(\s*newUserData\s*\)/);
    // A escrita muda de 44 bytes não pode voltar: era ELA que criava o arquivo
    // que o dono encontrou ao clicar em "editar".
    expect(indexCode).not.toMatch(/writeProvidersConfig\(path, \{\}, \[\]\)/);
  });

  it("o passo de boot vem ANTES do load que alimenta o watcher (nada de reload espúrio no boot)", () => {
    const bootstrapAt = indexCode.indexOf("bootstrapProvidersConfig(newUserData)");
    const bootLoadAt = indexCode.indexOf("const bootProvidersLoad = loadDynamicProviders(newUserData)");
    expect(bootstrapAt).toBeGreaterThan(0);
    expect(bootLoadAt).toBeGreaterThan(0);
    expect(bootstrapAt).toBeLessThan(bootLoadAt);
  });
});
