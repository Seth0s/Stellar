import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shippedProviderSpecs,
  PROVIDERS_APP_KEY,
  PROVIDERS_CONFIG_SCHEMA_VERSION,
  PROVIDERS_SCHEMA_FILENAME,
  bootstrapProvidersConfig,
  ensureProvidersConfigFile,
  formatProvidersSeedNotice,
  initialProvidersConfig,
  loadDynamicProviders,
  parseProviderSpec,
  parseProviderSpecs,
  planProvidersConfig,
  providersConfigPath,
  providersSchemaPath,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";
import { providerById } from "../../src/main/providers";

/**
 * DUAS CHAVES, DONO EXPLÍCITO (task 3fe0db6e, desenho aprovado pelo dono).
 *
 *   "providers":    []          <- do USUÁRIO. Nasce vazio. O app NUNCA escreve.
 *   "appProviders": [ ... ]     <- do APP. Completa, reescrita INTEIRA a cada boot.
 *
 * O que este arquivo trava: a chave do usuário intocada em TODOS os caminhos
 * (nascimento, migração, reescrita do app, corrida), a lista do app sempre
 * presente e idempotente, e a MIGRAÇÃO DE QUEM JÁ COPIU UMA DECLARAÇÃO INTEIRA
 * para `providers` — essa cópia continua vencendo (é o caso degenerado da
 * sobrescrita parcial, medido no bloco "migração").
 *
 * O último bloco não testa comportamento: ele pergunta "alguém chama isto?" —
 * a classe de falha que a d9aa8b1a pagou para aprender (função exportada,
 * testada e sem chamador atravessa `tsc`, teste e revisão).
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
function readConfig(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(providersConfigPath(dir), "utf8"));
}
/** O arquivo EXATO que o dono tinha em disco — 44 bytes, sem instrução. */
const POOR_FILE = `{ "schemaVersion": 1, "providers": [] }`;

const v1 = (): DynamicProviderSpec[] =>
  shippedProviderSpecs().map((spec) => structuredClone(spec) as DynamicProviderSpec);
/** O catálogo de uma versão NOVA do app: o commandcode ganhou uma flag. */
function v2Catalogue(): DynamicProviderSpec[] {
  const specs = v1();
  const commandcode = specs.find((spec) => spec.id === "commandcode")!;
  commandcode.baseArgs = [...(commandcode.baseArgs ?? []), "--flag-nova-do-app"];
  return specs;
}
const withFlag = ["--yolo", "--skip-onboarding", "--flag-nova-do-app"];

describe("planProvidersConfig — a decisão pura", () => {
  it("o nascimento: a chave do usuário vazia e a lista do app COMPLETA", () => {
    const plan = planProvidersConfig({ schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION }, v1());

    expect(plan.next.providers).toEqual([]);
    expect((plan.next[PROVIDERS_APP_KEY] as { id: string }[]).map((spec) => spec.id)).toEqual(["cline", "commandcode"]);
    // A declaração publicada é a MESMA que o app usa — não um resumo.
    expect(plan.next[PROVIDERS_APP_KEY]).toEqual(v1());
    expect(Object.keys(plan.next)).toEqual(["$schema", "schemaVersion", "providers", PROVIDERS_APP_KEY]);
  });

  it("`providers` (a chave do usuário) passa INTACTA — byte a byte, ordem incluída", () => {
    const doUsuario = [{ id: "meu-cli", label: "Meu CLI", binaryNames: ["x"], capacity: { role: "shell" } }];
    const plan = planProvidersConfig({ schemaVersion: 1, providers: doUsuario, _nota: "minha" }, v1());

    expect(plan.next.providers).toEqual(doUsuario);
    expect(plan.next._nota).toBe("minha");
  });

  it("`appProviders` é reescrita INTEIRA quando difere — e o fato é REPORTADO", () => {
    const antiga = [{ id: "commandcode", label: "declaração de uma versão antiga" }];
    const plan = planProvidersConfig({ schemaVersion: 1, providers: [], [PROVIDERS_APP_KEY]: antiga }, v1());

    expect(plan.next[PROVIDERS_APP_KEY]).toEqual(v1());
    expect(plan.appProvidersDiverged).toBe(true);
  });

  it("quando já é o que o app escreve, nada diverge (e a segunda passada não muda nada)", () => {
    const primeira = planProvidersConfig({ schemaVersion: 1 }, v1());
    const segunda = planProvidersConfig(primeira.next, v1());

    expect(segunda.appProvidersDiverged).toBe(false);
    expect(JSON.stringify(segunda.next)).toBe(JSON.stringify(primeira.next));
    expect(segunda.addedKeys).toEqual([]);
  });

  it("as chaves de instrução entram só quando faltam, e um `$schema` do usuário é preservado", () => {
    const plan = planProvidersConfig({ providers: [], $schema: "./meu-schema.json" }, v1());

    expect(plan.addedKeys).toEqual(["schemaVersion"]);
    expect(plan.next.$schema).toBe("./meu-schema.json");
  });

  it("o `_example` legado e chaves desconhecidas NUNCA são removidos", () => {
    const notas = { minhas: "notas" };
    const plan = planProvidersConfig({ schemaVersion: 1, providers: [], _example: notas, _x: 1 }, v1());

    expect(plan.next._example).toBe(notas);
    expect(plan.next._x).toBe(1);
  });
});

describe("ensureProvidersConfigFile — nascimento, idempotência e o que NÃO é tocado", () => {
  it("nasce com a sua lista vazia e a do app completa, e o arquivo passa pelo validador", () => {
    const dir = freshDir();
    expect(ensureProvidersConfigFile(dir, { shipped: v1() }).action).toBe("created");

    const born = readConfig(dir);
    expect(born.$schema).toBe("./providers.schema.json");
    expect(born.schemaVersion).toBe(PROVIDERS_CONFIG_SCHEMA_VERSION);
    expect(born.providers).toEqual([]);
    expect(born[PROVIDERS_APP_KEY].map((spec: { id: string }) => spec.id)).toEqual(["cline", "commandcode"]);
    expect(born).not.toHaveProperty("_example");
    // O arquivo inteiro é aceito pelo MESMO validador do usuário.
    expect(parseProviderSpecs(born, { appSpecs: v1() })).toEqual({ specs: [], rejected: [] });
    for (const spec of born[PROVIDERS_APP_KEY]) expect(parseProviderSpec(spec).ok).toBe(true);
  });

  it("é idempotente: segunda passada byte a byte igual ⇒ não escreve ⇒ mtime estável", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir, { shipped: v1() });
    const before = readFileSync(providersConfigPath(dir), "utf8");
    const beforeMtime = statSync(providersConfigPath(dir)).mtimeMs;

    const second = ensureProvidersConfigFile(dir, { shipped: v1() });

    expect(second.action).toBe("unchanged");
    expect(second.appProvidersRewritten).toBe(false);
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(before);
    expect(statSync(providersConfigPath(dir)).mtimeMs).toBe(beforeMtime);
  });

  it("o arquivo pobre do dono (44 bytes) ganha a lista do app, sem tocar na chave dele", () => {
    const dir = freshDir();
    writeFileSync(providersConfigPath(dir), POOR_FILE, "utf8");

    const result = ensureProvidersConfigFile(dir, { shipped: v1() });
    expect(result.action).toBe("applied");

    const written = readConfig(dir);
    expect(written.providers).toEqual([]);
    expect(written[PROVIDERS_APP_KEY].map((spec: { id: string }) => spec.id)).toEqual(["cline", "commandcode"]);
    expect(written.$schema).toBe("./providers.schema.json");
  });

  it("a lista do app é atualizada quando o app corrige (R2 automático)", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir, { shipped: v1() });

    const result = ensureProvidersConfigFile(dir, { shipped: v2Catalogue() });

    expect(result.action).toBe("applied");
    expect(result.appProvidersRewritten).toBe(true);
    const commandcode = readConfig(dir)[PROVIDERS_APP_KEY].find((spec: { id: string }) => spec.id === "commandcode");
    expect(commandcode.baseArgs).toEqual(withFlag);
  });

  it("JSON QUEBRADO não é tocado nem consertado", () => {
    const dir = freshDir();
    const broken = `{ "schemaVersion": 1, "providers": [ { "id": "meu" `;
    writeFileSync(providersConfigPath(dir), broken, "utf8");

    const result = ensureProvidersConfigFile(dir, { shipped: v1() });
    expect(result.action).toBe("invalid");
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(broken);
  });

  it("formato que este build NÃO entende não é reinterpretado", () => {
    const dir = freshDir();
    const futuro = `{\n  "schemaVersion": 99,\n  "providers": []\n}\n`;
    writeFileSync(providersConfigPath(dir), futuro, "utf8");

    const result = ensureProvidersConfigFile(dir, { shipped: v1() });
    expect(result.action).toBe("unsupported");
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(futuro);
  });

  it("apagar o arquivo não faz os dois sumirem — o catálogo também vive no binário", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir, { shipped: v1() });
    rmSync(providersConfigPath(dir));

    const semArquivo = loadDynamicProviders(dir);
    expect(semArquivo.registered).toEqual(expect.arrayContaining(["cline", "commandcode"]));
    expect(providerById("commandcode")).toBeDefined();

    // E o boot seguinte o recria.
    expect(ensureProvidersConfigFile(dir, { shipped: v1() }).action).toBe("created");
    expect(readConfig(dir)[PROVIDERS_APP_KEY].map((spec: { id: string }) => spec.id)).toEqual([
      "cline",
      "commandcode",
    ]);
  });
});

// ---------------------------------------------------------------------------
// A MIGRAÇÃO (exigência 1 do aceite): ninguém perde chave — inclusive quem já
// tinha COPIADO uma declaração inteira para `providers`. Essa cópia continua
// vencendo: é o caso degenerado da sobrescrita parcial (100% dos campos).
// ---------------------------------------------------------------------------
describe("migração: quem já copiou uma declaração inteira continua mandando nela", () => {
  it("a cópia antiga fica INTACTA no arquivo, e o app não a toca", () => {
    const dir = freshDir();
    const copiaDaVersaoAntiga = { ...(structuredClone(v1()[1]) as unknown as Record<string, unknown>) };
    writeFileSync(
      providersConfigPath(dir),
      JSON.stringify({ schemaVersion: 1, providers: [copiaDaVersaoAntiga] }, null, 2),
      "utf8",
    );

    ensureProvidersConfigFile(dir, { shipped: v1() });

    const written = readConfig(dir);
    expect(written.providers).toEqual([copiaDaVersaoAntiga]);
    // E a lista do app foi acrescentada ao lado dela.
    expect(written[PROVIDERS_APP_KEY].map((spec: { id: string }) => spec.id)).toEqual(["cline", "commandcode"]);
  });

  it("MEDIDO: a cópia VENCE a lista do app campo a campo (todos os campos são dela)", () => {
    const dir = freshDir();
    const copiaComAjuste = { ...(structuredClone(v1()[1]) as unknown as Record<string, unknown>), baseArgs: ["--meu-jeito"] };
    writeFileSync(
      providersConfigPath(dir),
      JSON.stringify({ schemaVersion: 1, providers: [copiaComAjuste] }, null, 2),
      "utf8",
    );

    loadDynamicProviders(dir, { shipped: v2Catalogue() });

    // O ajuste do usuário venceu…
    expect(providerById("commandcode")?.buildArgs({})).toEqual(["--meu-jeito"]);
    // …e a correção do app NÃO chegou a esta entrada: é o preço declarado de
    // copiar a declaração inteira (a razão de a sobrescrita por campo existir).
    expect(providerById("commandcode")?.buildArgs({})).not.toEqual(withFlag);
  });
});

// ---------------------------------------------------------------------------
// A CORRIDA (exigência 2): o app abrindo ENQUANTO o usuário edita o mesmo
// arquivo. Sem o compare-and-swap a janela de perda é a passada inteira; com
// ele o app relê imediatamente antes do `rename` e desiste se algo mudou.
// ---------------------------------------------------------------------------
describe("a corrida com o watcher: quem edita durante o boot não perde o trabalho", () => {
  it("se o arquivo mudar entre a leitura e a gravação, o app NÃO sobrescreve (`raced`)", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir, { shipped: v1() });
    rmSync(providersConfigPath(dir));
    const doUsuario = `${JSON.stringify({ schemaVersion: 1, providers: [], _noMeio: true }, null, 2)}\n`;

    const result = ensureProvidersConfigFile(dir, {
      shipped: v1(),
      beforeWrite: () => writeFileSync(providersConfigPath(dir), doUsuario, "utf8"),
    });

    expect(result.action).toBe("raced");
    expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(doUsuario);
  });

  it("sem corrida, o mesmo caminho grava normalmente", () => {
    const dir = freshDir();
    expect(ensureProvidersConfigFile(dir, { shipped: v1() }).action).toBe("created");
  });
});

describe("formatProvidersSeedNotice — o relato não é silencioso", () => {
  it("nascimento e atualização têm linha; nada aconteceu ⇒ silêncio", () => {
    const dir = freshDir();
    expect(formatProvidersSeedNotice(ensureProvidersConfigFile(dir, { shipped: v1() }))).toContain(PROVIDERS_APP_KEY);

    const applied = ensureProvidersConfigFile(dir, { shipped: v2Catalogue() });
    const linha = formatProvidersSeedNotice(applied);
    expect(linha).toContain("atualizei a lista do app");
    expect(linha).toContain("não era o que este build escreve");

    expect(formatProvidersSeedNotice(ensureProvidersConfigFile(dir, { shipped: v2Catalogue() }))).toBeNull();
  });

  it("a corrida é dita, e diz que o app NÃO sobrescreveu", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir, { shipped: v1() });
    const raced = ensureProvidersConfigFile(dir, {
      shipped: v2Catalogue(),
      beforeWrite: () => writeFileSync(providersConfigPath(dir), POOR_FILE, "utf8"),
    });
    expect(formatProvidersSeedNotice(raced)).toContain("NÃO sobrescrevi");
  });
});

describe("bootstrapProvidersConfig — o passo de boot, e o `$schema` que o editor resolve", () => {
  it("publica o schema ao lado E semeia o arquivo, com a referência RELATIVA resolvendo no disco", () => {
    const dir = freshDir();
    const result = bootstrapProvidersConfig(dir);

    expect(result.schema.written).toBe(true);
    expect(result.config.action).toBe("created");

    const ref = readConfig(dir).$schema;
    expect(ref).toBe(`./${PROVIDERS_SCHEMA_FILENAME}`);
    const schema = JSON.parse(readFileSync(providersSchemaPath(dir), "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    // As duas chaves estão documentadas COM DONO — é o que torna o arquivo
    // autoexplicativo para quem nunca viu este repo (exigência 3).
    expect(schema.properties.providers.description).toContain("SUA lista");
    expect(schema.properties[PROVIDERS_APP_KEY].description).toContain("DO APP");
  });

  it("é idempotente: o segundo boot não reescreve nem o schema nem o arquivo", () => {
    const dir = freshDir();
    bootstrapProvidersConfig(dir);
    const second = bootstrapProvidersConfig(dir);

    expect(second.schema.written).toBe(false);
    expect(second.config.action).toBe("unchanged");
    expect(second.config.error).toBeNull();
  });

  it("`initialProvidersConfig` é exatamente o que o nascimento grava", () => {
    const dir = freshDir();
    ensureProvidersConfigFile(dir);
    expect(readConfig(dir)).toEqual(initialProvidersConfig());
  });
});

// ---------------------------------------------------------------------------
// O GATE DE FIAÇÃO — a pergunta que faltava.
//
// Uma função exportada, com teste verde e sem chamador, atravessa `tsc`, o
// `vitest` e a revisão: foi o que aconteceu com a semeadura antes da d9aa8b1a.
// Estes testes leem o ponto de fiação (`src/main/index.ts`) e falham se ele
// desaparecer.
//
// O que eles NÃO são: prova de que a fiação FUNCIONA em runtime — a prova de
// efeito é o smoke isolado (`scripts/verify/smoke-providers-config-seed.mjs`),
// que sobe o app de verdade e lê o arquivo do disco.
// ---------------------------------------------------------------------------
describe("fiação de produção — alguém CHAMA isto?", () => {
  const indexSource = readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  // Sem comentários: os gates procuram CÓDIGO, e o arquivo tem comentários que
  // CITAM chamadas antigas para explicar por que elas saíram.
  const indexCode = indexSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  function importedFromProvidersDynamic(symbol: string): boolean {
    const match = /import\s*\{([\s\S]*?)\}\s*from\s*"\.\/providers-dynamic";/.exec(indexCode);
    if (match === null) return false;
    return match[1]
      .split(",")
      .map((entry) => entry.replace(/\/\/.*$/gm, "").trim())
      .some((entry) => entry === symbol || entry === `type ${symbol}`);
  }

  it("o boot chama `bootstrapProvidersConfig`", () => {
    expect(importedFromProvidersDynamic("bootstrapProvidersConfig")).toBe(true);
    expect(indexCode).toMatch(/bootstrapProvidersConfig\(\s*newUserData\s*\)/);
  });

  it("o relato do passo de boot é IMPRESSO (inclusive o aviso de reescrita)", () => {
    expect(importedFromProvidersDynamic("formatProvidersSeedNotice")).toBe(true);
    expect(indexCode).toMatch(/formatProvidersSeedNotice\(/);
  });

  it("o caminho de 'abrir no editor' usa a MESMA semeadura, não uma segunda escrita", () => {
    expect(importedFromProvidersDynamic("ensureProvidersConfigFile")).toBe(true);
    expect(indexCode).toMatch(/ensureProvidersConfigFile\(\s*newUserData\s*\)/);
    expect(indexCode).not.toMatch(/writeProvidersConfig\(path, \{\}, \[\]\)/);
  });

  it("o passo de boot vem ANTES do load e do watcher (nada de reload espúrio no boot)", () => {
    const bootstrapAt = indexCode.indexOf("bootstrapProvidersConfig(newUserData)");
    const bootLoadAt = indexCode.indexOf("const bootProvidersLoad = loadDynamicProviders(newUserData, { shipped: SHIPPED_APP_SPECS })");
    const watcherAt = indexCode.indexOf("createProvidersConfigWatcher({");
    expect(bootstrapAt).toBeGreaterThan(0);
    expect(bootLoadAt).toBeGreaterThan(0);
    expect(watcherAt).toBeGreaterThan(0);
    expect(bootstrapAt).toBeLessThan(bootLoadAt);
    expect(bootLoadAt).toBeLessThan(watcherAt);
  });

  it("a tela rotula a origem pela LISTA do app (`appIds`), não por um campo da entrada", () => {
    // O vocabulário da tela é o badge "do app"; com as duas chaves, a origem é a
    // chave em que a entrada está. Se a tela voltasse a olhar um campo `source`
    // (que não existe mais), ela diria "seu" para o que é do app.
    expect(indexCode).toMatch(/loaded\.appIds/);
    expect(indexCode).not.toMatch(/source === "app"/);
  });

  it("a origem 'do app' (view) e o caminho (A)/(B) do handler leem o MESMO catálogo", () => {
    // Parecer do Revisor A (task 1cac9dcd) — o acoplamento frágil que esta
    // asserção desarma: a VIEW decidia "do app" pela lista do LOADER
    // (`loaded.appIds`, derivada do `shipped` que ele usou) e o HANDLER, por um
    // `shippedProviderSpecs().find` escrito de novo ali. Os dois conjuntos
    // coincidiam POR ACIDENTE — o default do loader é este mesmo catálogo.
    //
    // Se um dia o `shipped` virar configurável, um id que a tela mostra como
    // "do app" cairia no caminho (A) do `app:add-provider`, que grava a
    // declaração INTEIRA — e o provider voltaria a CONGELAR, que é o defeito
    // que a 1cac9dcd removeu. Por isso o catálogo tem UM nome, e ele vai
    // EXPLÍCITO para todo load (nada depende do default).
    //
    // A LIÇÃO DO PARÊNTESE (task 3fe0db6e, o 13º falso-verde desta base): o
    // `()` de uma chamada dentro de REGEX é GRUPO VAZIO, não parêntese literal.
    // Quando o catálogo saiu do TypeScript e virou dado (`shippedProviderSpecs()`
    // em vez do literal), esta linha e a de baixo passaram a casar TEXTO DIFERENTE
    // do que existe para proibir, e a de baixo continuou VERDE: medido —
    // `/shippedProviderSpecs()\.(find|map|filter)\(/` casa `shippedProviderSpecs.find(`,
    // que NÃO existe, e NÃO casa `shippedProviderSpecs().find(`, que é o alvo.
    // Todo `()` dentro de regex é `\(\)`; e um `not.toMatch` que não casa nada
    // pelo motivo errado é indistinguível de uma garantia.
    expect(indexCode).toMatch(/const SHIPPED_APP_SPECS = shippedProviderSpecs\(\)/);
    // O catálogo não voltou a ser literal de TypeScript: o nome antigo não pode
    // reaparecer em lugar nenhum do main.
    expect(indexCode).not.toMatch(/MEASURED_THIRD_PARTY_SPECS/);

    const loads = indexCode.match(/loadDynamicProviders\([^)]*\)/g) ?? [];
    expect(loads.length).toBeGreaterThan(0);
    for (const call of loads) expect(call).toContain("shipped: SHIPPED_APP_SPECS");

    // O handler escolhe o caminho por esse nome — e não deriva o seu de novo.
    expect(indexCode).toMatch(/SHIPPED_APP_SPECS\.find\(/);
    expect(indexCode).not.toMatch(/shippedProviderSpecs\(\)\.(find|map|filter)\(/);
  });
});
