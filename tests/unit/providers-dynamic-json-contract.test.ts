import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shippedProviderSpecs,
  measuredProviderRecipes,
  PROVIDERS_CONFIG_FILENAME,
  PROVIDERS_SCHEMA_FILENAME,
  PROVIDERS_SCHEMA_REF,
  ensureProvidersSchemaFile,
  initialProvidersConfig,
  initialProvidersConfigJson,
  loadDynamicProviders,
  measuredProviderRecipes,
  parseProviderSpec,
  parseProviderSpecs,
  parseSessionStore,
  providersConfigPath,
  providersConfigSchema,
  providersConfigSchemaJson,
  providersSchemaPath,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";

/**
 * O CONTRATO do `providers.json` (task 64aed52b, parte B).
 *
 * O relato: "o json para editar não tem os campos aceitáveis (instrução), e
 * sem instrução nenhuma". Três peças: schema publicado e apontado por
 * `$schema`, arquivo inicial exemplificado em vez de vazio, e recusas que
 * dizem CAMPO + VALOR ACEITO.
 *
 * O TESTE QUE IMPORTA AQUI é o anti-drift: ele percorre o SCHEMA e confronta
 * cada obrigatoriedade e cada enum com o que `parseProviderSpec` realmente
 * aceita. É o que impede o schema de virar a segunda verdade — um schema que
 * mente é pior que schema nenhum, porque o editor autocompletaria exatamente
 * o que o loader recusa. Se este teste falhar, o schema e o parser
 * DIVERGIRAM: conserte o par, não o teste.
 */

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-provcontract-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Anti-drift: schema × parser
// ---------------------------------------------------------------------------

type ContractItem = { path: string; kind: "required"; field: string } | { path: string; kind: "enum" };

/** Percorre o schema coletando obrigatoriedades e enums, com o caminho do
 * campo em notação de ponto. `items` e `if`/`then`/`else` falam do MESMO
 * objeto — o caminho não muda ao descer neles. */
function collect(node: unknown, path: string, out: ContractItem[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.required)) {
    for (const field of record.required) {
      if (typeof field === "string") out.push({ path, kind: "required", field });
    }
  }
  if (Array.isArray(record.enum)) out.push({ path, kind: "enum" });
  if (record.properties !== null && typeof record.properties === "object") {
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      collect(value, path === "" ? key : `${path}.${key}`, out);
    }
  }
  if (record.items !== undefined) collect(record.items, path, out);
  for (const key of ["if", "then", "else"]) {
    if (record[key] !== undefined) collect(record[key], path, out);
  }
}

function getAtPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, root);
}

function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node: Record<string, unknown> | undefined = root;
  for (const key of keys.slice(0, -1)) {
    const next = node?.[key];
    node = next !== null && typeof next === "object" ? (next as Record<string, unknown>) : undefined;
    if (!node) return;
  }
  node[keys[keys.length - 1]] = value;
}

function deleteAtPath(root: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  let node: Record<string, unknown> | undefined = root;
  for (const key of keys.slice(0, -1)) {
    const next = node?.[key];
    node = next !== null && typeof next === "object" ? (next as Record<string, unknown>) : undefined;
    if (!node) return;
  }
  delete node[keys[keys.length - 1]];
}

/** Dois specs VÁLIDOS e maximalistas, um por ramo de mecanismo (flag e
 * none) — um só não cobre os dois ramos condicionais do schema. */
const MAX_FLAG: DynamicProviderSpec = {
  id: "qa-contract-flag",
  label: "Contract flag",
  binaryNames: ["qa-contract-flag"],
  installCommand: { posix: "npm install -g x", windows: "npm install -g x" },
  baseArgs: ["--yolo"],
  capacity: {
    role: "agent",
    session: {
      canImposeSessionId: true,
      imposeFlag: "--id",
      resumeFlag: "--resume",
      continueFlag: "--continue",
      // O ramo `kind:"files"` (task 2ea0269f): as obrigatoriedades e os enums
      // aninhados do store só são cobertos por uma base que DECLARE um store.
      store: {
        kind: "files",
        root: "~/.qa/projects/{cwd:dashes}",
        pattern: "*.jsonl",
        id: { from: "fileName", strip: ".jsonl" },
        cwd: { from: "root" },
        time: { from: "mtime" },
        read: { exists: "{id}.jsonl", content: { minBytes: 16 } },
      },
    },
    systemPrompt: { mechanism: "flag", flag: "-s" },
    mcp: { mechanism: "global-config", configPath: "~/.x/mcp.json", configKey: "mcpServers", serverShape: "stdio-command" },
    acbridgeOnPath: true,
    effort: { mechanism: "flag", flag: "--effort", values: ["low", "high"] },
    model: { mechanism: "flag", flag: "-m" },
    delivery: {
      briefMechanism: "flag",
      briefFlag: "--prompt",
      // O ramo `turnEnd.mechanism: "screen"` (task 0dd5c145): é ele que carrega
      // `pattern`, o obrigatório condicional NOVO. Sem uma base que declare um
      // `turnEnd`, o anti-drift abaixo acusa o caminho como não coberto — que
      // foi exatamente como este teste pegou o campo novo.
      turnEnd: { mechanism: "screen", pattern: "Worked for \\d+s" },
    },
  },
};

const MAX_NONE: DynamicProviderSpec = {
  id: "qa-contract-none",
  label: "Contract none",
  binaryNames: ["qa-contract-none"],
  installCommand: null,
  capacity: {
    role: "shell",
    session: { canImposeSessionId: false },
    systemPrompt: { mechanism: "none" },
    mcp: { mechanism: "none" },
    acbridgeOnPath: false,
    effort: { mechanism: "none", reason: "shell" },
    model: { mechanism: "none", reason: "shell" },
    delivery: { briefMechanism: "none" },
  },
};

/** O ramo `store.kind: "sqlite"` — `files` (na MAX_FLAG) não cobre
 * `discovery.*` nem `timeFormat`, que são obrigatório/enum SÓ dele. Uma base
 * por ramo é o mesmo critério que separa MAX_FLAG de MAX_NONE. */
const MAX_STORE_SQLITE: DynamicProviderSpec = {
  id: "qa-contract-sqlite",
  label: "Contract sqlite",
  binaryNames: ["qa-contract-sqlite"],
  installCommand: null,
  capacity: {
    role: "agent",
    session: {
      canImposeSessionId: false,
      resumeFlag: "--session",
      store: {
        kind: "sqlite",
        db: "~/.qa/qa.db",
        timeFormat: "iso-8601",
        discovery: { table: "sessions", idColumn: "session_id", cwdColumn: "cwd", timeColumn: "started_at" },
        read: {
          table: "sessions",
          idColumn: "session_id",
          timeColumn: "updated_at",
          contentTable: "messages",
          contentColumn: "session_id",
        },
      },
    },
    systemPrompt: { mechanism: "none" },
    mcp: { mechanism: "none" },
    acbridgeOnPath: false,
    effort: { mechanism: "none", reason: "unmeasured" },
    model: { mechanism: "flag", flag: "-m" },
    // O OUTRO ramo do `turnEnd` (task 0dd5c145): `hook` não carrega `pattern`,
    // e o enum do schema precisa dos dois valores cobertos por uma base.
    delivery: { briefMechanism: "none", turnEnd: { mechanism: "hook" } },
  },
};

/**
 * UMA BASE COM `readiness` (task 1777060e). O gate acima exige que TODO campo
 * obrigatório do schema seja recusado pelo parser NOMEANDO o campo — e para
 * `readiness.kind/args/okPath/timeoutMs` isso só é produzível a partir de uma
 * base que DECLARE um probe válido (tirar um subcampo de um objeto ausente não
 * produz recusa nenhuma, e o gate acusa o buraco — foi assim que ele pegou esta
 * adição de schema, antes de a sonda existir no parser).
 */
const MAX_READINESS: DynamicProviderSpec = {
  ...(structuredClone(MAX_NONE) as DynamicProviderSpec),
  id: "qa-contract-readiness",
  readiness: {
    kind: "command",
    args: ["auth-broker", "status", "--json"],
    okPath: "ok",
    timeoutMs: 2_000,
    hint: "qa-contract auth-broker login",
  },
};

const BASES = [MAX_FLAG, MAX_NONE, MAX_STORE_SQLITE, MAX_READINESS];

describe("anti-drift: o schema publicado não pode divergir do parser", () => {
  it("as bases do teste são válidas pelo próprio validador", () => {
    for (const base of BASES) {
      const parsed = parseProviderSpec(base);
      expect(parsed.ok, `${base.id}: ${parsed.ok ? "" : parsed.reason}`).toBe(true);
    }
  });

  it("TODO campo obrigatório do schema é recusado pelo parser, e a recusa NOMEIA o campo", () => {
    const schema = providersConfigSchema() as Record<string, unknown>;
    const items: ContractItem[] = [];
    collect(schema, "", items);
    const providerItems = items.filter((item) => item.path.startsWith("providers."));
    const required = providerItems.filter(
      (item): item is { path: string; kind: "required"; field: string } => item.kind === "required",
    );
    expect(required.length).toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const item of required) {
      const specPath = item.path === "providers" ? item.field : `${item.path.slice("providers.".length)}.${item.field}`;
      const covered = BASES.some((base) => {
        const candidate = structuredClone(base) as unknown as Record<string, unknown>;
        deleteAtPath(candidate, specPath);
        const parsed = parseProviderSpec(candidate);
        return !parsed.ok && parsed.reason.includes(specPath);
      });
      if (!covered) uncovered.push(specPath);
    }

    // Se isto falhar, o schema exige um campo que o parser não exige (ou o
    // exige com outro nome) — ou falta cobrir o caminho novo nas bases acima.
    expect(uncovered).toEqual([]);
  });

  it("TODO enum do schema é recusado pelo parser quando o valor está fora dele, nomeando o campo", () => {
    const schema = providersConfigSchema() as Record<string, unknown>;
    const items: ContractItem[] = [];
    collect(schema, "", items);
    const enums = items.filter(
      (item): item is { path: string; kind: "enum" } => item.kind === "enum" && item.path.startsWith("providers."),
    );
    expect(enums.length).toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const item of enums) {
      const specPath = item.path.slice("providers.".length);
      const covered = BASES.some((base) => {
        const candidate = structuredClone(base) as unknown as Record<string, unknown>;
        setAtPath(candidate, specPath, "__nope__");
        const parsed = parseProviderSpec(candidate);
        return !parsed.ok && parsed.reason.includes(specPath);
      });
      if (!covered) uncovered.push(specPath);
    }

    expect(uncovered).toEqual([]);
  });

  it("os enums do schema saem das MESMAS listas que o parser usa (amostra direta)", () => {
    const schema = JSON.stringify(providersConfigSchema());
    for (const value of ["agent", "shell", "global-config", "stdio-command", "local-array", "positional", "unmeasured", "no-flag"]) {
      expect(schema).toContain(`"${value}"`);
    }
  });

  it("no nível do ARQUIVO, o schema exige o que `parseProviderSpecs` exige — e as recusas nomeiam o campo", () => {
    const schema = providersConfigSchema() as { required: string[] };
    expect(schema.required).toEqual(["schemaVersion", "providers"]);

    const missingVersion = parseProviderSpecs({ providers: [] }).rejected[0];
    expect(missingVersion.index).toBe(-1);
    expect(missingVersion.reason).toContain("schemaVersion");

    const wrongVersion = parseProviderSpecs({ schemaVersion: 99, providers: [] }).rejected[0].reason;
    expect(wrongVersion).toContain("schemaVersion");
    expect(wrongVersion).toContain("must be the number 1");

    const missingProviders = parseProviderSpecs({ schemaVersion: 1 }).rejected[0].reason;
    expect(missingProviders).toContain("providers");
    expect(missingProviders).toContain("must be an array");
  });
});

// ---------------------------------------------------------------------------
// O schema em si
// ---------------------------------------------------------------------------

describe("o schema publicado", () => {
  it("é um JSON Schema 2020-12 com os campos de topo esperados", () => {
    const schema = providersConfigSchema() as Record<string, any>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    // As DUAS listas com dono explícito (task 3fe0db6e): `providers` é do
    // usuário, `appProviders` é do app. `_example` é legado mantido por
    // compatibilidade de leitura (nunca removido de um arquivo que o tenha).
    expect(Object.keys(schema.properties)).toEqual(["$schema", "schemaVersion", "providers", "appProviders", "_example"]);
    expect(schema.properties.schemaVersion.const).toBe(1);
    // A origem é a LISTA em que a entrada está — e é isso que o schema diz.
    expect(schema.properties.appProviders.description).toContain("DO APP");
    expect(schema.properties.providers.description).toContain("SUA lista");
    expect(schema.properties.providers.items.properties.baseArgs.type).toBe("array");
    expect(schema.properties.providers.items.properties.baseArgs.items.minLength).toBe(1);
    // Só `id` é obrigatório: uma entrada parcial (a sobrescrita por campo) é
    // legítima — o resto vem de `appProviders`.
    expect(schema.properties.providers.items.required).toEqual(["id"]);
    // O efeito é DECLARADO no schema (task c857539c), com a exigência de
    // medição escrita na description — é o que deixa o dono declarar o
    // bypass da CLI DELE sem o Stellar deduzir string nenhuma.
    expect(schema.properties.providers.items.properties.bypassesPermissionPrompts.type).toBe("boolean");
    expect(schema.properties.providers.items.properties.bypassesPermissionPrompts.description).toContain("MEDIDO");
  });

  it("o efeito é DECLARADO, nunca deduzido: commandcode true (medido), cline e o exemplo sem claim", () => {
    const commandcode = shippedProviderSpecs().find((entry) => entry.id === "commandcode");
    expect(commandcode?.baseArgs).toEqual(["--yolo", "--skip-onboarding"]);
    expect(commandcode?.bypassesPermissionPrompts).toBe(true);
    // Sem medição, sem claim: cline não ganhou flag nem efeito.
    const cline = shippedProviderSpecs().find((entry) => entry.id === "cline");
    expect(cline?.bypassesPermissionPrompts).toBeUndefined();
    // E a receita publicada não ensina a declarar efeito sem medição.
    expect(measuredProviderRecipes()[0].bypassesPermissionPrompts).toBeUndefined();
  });

  it("documenta o `baseArgs` com a posição e o que é recusado (é a instrução do campo)", () => {
    const schema = providersConfigSchema() as Record<string, any>;
    const description: string = schema.properties.providers.items.properties.baseArgs.description;
    expect(description).toContain("--yolo");
    expect(description).toContain("ANTES");
    expect(description).toContain("`--`");
  });

  it("serializa como JSON válido, com quebra de linha final", () => {
    const json = providersConfigSchemaJson();
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toEqual(providersConfigSchema());
  });
});

// ---------------------------------------------------------------------------
// A RECEITA COPIÁVEL (task 49796d45)
//
// O dono clicou em "editar" e não achou cline nem commandcode no arquivo. A
// metade de camada desta task está travada fora daqui: mover os specs para o
// `providers.json` do usuário COLAPSA a precedência de três níveis (medido:
// apagar o arquivo faz o `commandcode` sumir; uma cópia velha vence o embutido
// e o app perde a capacidade de corrigi-la). O que estes testes travam é a
// metade de APRESENTAÇÃO: a receita é GERADA das specs embutidas, publicada no
// schema que o app reescreve a cada boot, e AVISA o custo de copiar.
// ---------------------------------------------------------------------------

describe("a receita copiável no schema publicado", () => {
  it("os `examples` SÃO as specs embutidas — gerados, não um literal ao lado", () => {
    // Se alguém trocar a geração por um literal, este teste é o que cai no dia
    // em que o catálogo mudar (é o anti-drift da receita, o mesmo padrão que o
    // resto do arquivo usa contra o parser).
    const items = getAtPath(providersConfigSchema(), "properties.providers.items") as Record<string, unknown>;
    expect(items.examples).toEqual(shippedProviderSpecs());
    expect(measuredProviderRecipes().map((spec) => spec.id)).toEqual(["cline", "commandcode"]);
  });

  it("são CÓPIAS: mutar o que o schema publica não pode mexer no catálogo vivo", () => {
    const examples = measuredProviderRecipes();
    examples[0].label = "mutado pelo leitor";
    examples[0].capacity.delivery.briefMechanism = "none";
    expect(shippedProviderSpecs()[0].label).not.toBe("mutado pelo leitor");
    expect(shippedProviderSpecs()[0].capacity.delivery.briefMechanism).toBe("positional");
  });

  it("cada receita é COPIÁVEL: passa pelo MESMO validador e pelo MESMO schema do arquivo do usuário", () => {
    for (const recipe of measuredProviderRecipes()) {
      const parsed = parseProviderSpec(recipe);
      expect(parsed.ok, `${recipe.id}: ${parsed.ok ? "" : parsed.reason}`).toBe(true);
      // O gesto literal de colar: um arquivo com ela dentro tem de ser
      // declaração VÁLIDA — receita que o loader recusa seria a primeira
      // instrução errada que o usuário leria.
      const pasted = parseProviderSpecs({ schemaVersion: 1, providers: [recipe] });
      expect(pasted.specs.map((spec) => spec.id)).toEqual([recipe.id]);
      expect(pasted.rejected).toEqual([]);
    }
  });

  it("a receita AVISA que o jeito certo é SOBRESCREVER UM CAMPO, não copiar a entrada", () => {
    // O desenho mudou (task 3fe0db6e): com as duas chaves, ninguém precisa
    // copiar declaração inteira — e a instrução publicada tem de dizer isso,
    // senão o usuário repete o caso (D) medido antes (a cópia que congela).
    const schema = providersConfigSchema() as Record<string, any>;
    const providers: string = schema.properties.providers.description;
    expect(providers).toContain("SOBRESCRITA");
    expect(providers).toContain("SUBSTITUEM"); // arrays substituem, não concatenam
    expect(providers).toContain("commandcode"); // o exemplo de três linhas
    // E diz que o app já entrega os dois prontos: não precisa escrever nada.
    expect(schema.properties.appProviders.description).toContain("do app");
  });

  it("a lista do app também está no SCHEMA `examples` (a forma completa, para um provider novo)", () => {
    // Com a sobrescrita parcial o `required` é só `id` — então o `examples`
    // passa a ser o único lugar do schema que mostra uma declaração COMPLETA.
    expect(providersConfigSchema().properties.providers.items).toHaveProperty("examples");
    expect(measuredProviderRecipes().map((spec) => spec.id)).toEqual(["cline", "commandcode"]);
  });

  it("chega ao DISCO com o schema ao lado do arquivo do usuário (é o que o editor lê)", () => {
    const dir = freshDir();
    const result = ensureProvidersSchemaFile(dir);
    expect(result.error).toBeNull();

    const onDisk = JSON.parse(readFileSync(providersSchemaPath(dir), "utf8"));
    expect(onDisk.properties.providers.items.examples.map((spec: { id: string }) => spec.id)).toEqual([
      "cline",
      "commandcode",
    ]);
    // E o arquivo do usuário aponta para ele — é assim que o editor acha a
    // instrução sem o usuário procurar.
    expect(initialProvidersConfig().$schema).toBe(PROVIDERS_SCHEMA_REF);
  });
});

// ---------------------------------------------------------------------------
// O arquivo inicial
// ---------------------------------------------------------------------------

describe("o arquivo inicial (primeiro save)", () => {
  it("não é um arquivo vazio: aponta o schema, deixa a SUA lista vazia e mostra a do app", () => {
    const initial = initialProvidersConfig();
    expect(initial.$schema).toBe(PROVIDERS_SCHEMA_REF);
    expect(initial.schemaVersion).toBe(1);
    // A chave do usuário nasce vazia — o app nunca escreve nela.
    expect(initial.providers).toEqual([]);
    // E a lista do app nasce COMPLETA e visível.
    expect((initial.appProviders as { id: string }[]).map((spec) => spec.id)).toEqual(["cline", "commandcode"]);
    // O `_example` fictício saiu (task 3fe0db6e).
    expect(initial).not.toHaveProperty("_example");
  });

  it("a lista do app NÃO é lida como entrada do usuário (e o arquivo é aceito sem recusas)", () => {
    const dir = freshDir();
    writeFileSync(providersConfigPath(dir), initialProvidersConfigJson(), "utf8");

    const loaded = loadDynamicProviders(dir, { shipped: [] });

    expect(loaded.fileRead).toBe(true);
    expect(loaded.error).toBeNull();
    expect(loaded.rejected).toEqual([]);
    // `appProviders` é do app: com o catálogo do binário vazio (`shipped: []`),
    // nada é registrado — a lista do arquivo não vira provider por si só.
    expect(loaded.registered).toEqual([]);
    expect(loaded.removed).toEqual([]);
  });

  it("continua sendo um arquivo que o loader aceita com chaves extras (`$schema`, `_example` legado)", () => {
    const dir = freshDir();
    const withProvider = initialProvidersConfig();
    withProvider._example = { id: "minha-cli" };
    withProvider.providers = [measuredProviderRecipes()[0]];
    writeFileSync(providersConfigPath(dir), `${JSON.stringify(withProvider, null, 2)}\n`, "utf8");

    const loaded = loadDynamicProviders(dir, { shipped: [] });
    expect(loaded.rejected).toEqual([]);
    expect(loaded.registered).toEqual(["cline"]);
  });
});

// ---------------------------------------------------------------------------
// ensureProvidersSchemaFile
// ---------------------------------------------------------------------------

describe("ensureProvidersSchemaFile", () => {
  it("escreve na primeira vez e NÃO reescreve quando já está igual (idempotente)", () => {
    const dir = freshDir();

    const first = ensureProvidersSchemaFile(dir);
    expect(first.written).toBe(true);
    expect(first.error).toBeNull();
    expect(first.path).toBe(providersSchemaPath(dir));
    expect(readFileSync(first.path, "utf8")).toBe(providersConfigSchemaJson());

    const second = ensureProvidersSchemaFile(dir);
    expect(second.written).toBe(false);
    expect(second.error).toBeNull();
  });

  it("substitui um schema VELHO (o caso do upgrade do app) sem deixar temporário para trás", () => {
    const dir = freshDir();
    const path = providersSchemaPath(dir);
    writeFileSync(path, '{"title":"schema de uma versão antiga"}', "utf8");

    const result = ensureProvidersSchemaFile(dir);

    expect(result.written).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(providersConfigSchema());
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("nunca lança: falha de escrita volta como `error`, com o registro do app intacto", () => {
    const dir = freshDir();
    // Um DIRETÓRIO no caminho do temporário faz o writeFileSync falhar.
    mkdirSync(`${providersSchemaPath(dir)}.tmp`, { recursive: true });

    const result = ensureProvidersSchemaFile(dir);

    expect(result.written).toBe(false);
    expect(result.error).not.toBeNull();
    expect(existsSync(providersSchemaPath(dir))).toBe(false);
  });

  it("o arquivo que ele escreve é JSON válido e o MESMO objeto devolvido por `providersConfigSchema`", () => {
    const dir = freshDir();
    const result = ensureProvidersSchemaFile(dir);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual(providersConfigSchema());
  });
});

// ---------------------------------------------------------------------------
// As recusas dizem CAMPO + VALOR ACEITO (+ o que chegou)
// ---------------------------------------------------------------------------

function baseSpec(): DynamicProviderSpec {
  return {
    id: "qa-contract-refusal",
    label: "Refusal",
    binaryNames: ["qa-contract-refusal"],
    installCommand: null,
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
}

describe("recusas acionáveis: campo + valor aceito + valor recebido", () => {
  const cases: { name: string; mutate: (spec: Record<string, unknown>) => void; expect: string[] }[] = [
    {
      name: "role fora do enum",
      mutate: (s) => setAtPath(s, "capacity.role", "tool"),
      expect: ["`capacity.role` must be one of \"agent\" or \"shell\"", 'got "tool"'],
    },
    {
      name: "id com forma inválida",
      mutate: (s) => setAtPath(s, "id", "Meu CLI"),
      expect: ["`id` must be a string matching /^[a-z0-9][a-z0-9-]*$/", 'got "Meu CLI"'],
    },
    {
      name: "id ausente",
      mutate: (s) => deleteAtPath(s, "id"),
      expect: ["`id` must be", "got absent"],
    },
    {
      name: "binaryNames com item vazio",
      mutate: (s) => setAtPath(s, "binaryNames", ["ok", ""]),
      expect: ["`binaryNames` must be a non-empty array of non-empty strings", 'got ["ok",""]'],
    },
    {
      name: "session flag vazia (diz QUAL das três)",
      mutate: (s) => setAtPath(s, "capacity.session.resumeFlag", "  "),
      expect: ["`capacity.session.resumeFlag` must be", "got \"  \""],
    },
    {
      name: "installCommand sem windows (diz QUAL dos dois)",
      mutate: (s) => setAtPath(s, "installCommand", { posix: "npm i -g x" }),
      expect: ["`installCommand.windows` must be", "got absent"],
    },
    {
      name: "effort.reason fora do enum",
      mutate: (s) => setAtPath(s, "capacity.effort", { mechanism: "none", reason: "porque-sim" }),
      expect: ["`capacity.effort.reason` must be one of \"shell\", \"no-flag\" or \"unmeasured\"", 'got "porque-sim"'],
    },
    {
      name: "model sem reason",
      mutate: (s) => setAtPath(s, "capacity.model", { mechanism: "none" }),
      expect: ["`capacity.model.reason` must be \"shell\"", "got absent"],
    },
    {
      name: "mcp global-config sem configKey",
      mutate: (s) =>
        setAtPath(s, "capacity.mcp", { mechanism: "global-config", configPath: "~/.x/mcp.json", serverShape: "stdio-command" }),
      expect: ["`capacity.mcp.configKey` must be", "got absent"],
    },
    {
      name: "baseArgs com item vazio",
      mutate: (s) => setAtPath(s, "baseArgs", ["--ok", ""]),
      expect: ["`baseArgs[1]` must be a non-empty string", 'got ""'],
    },
    {
      name: "bypassesPermissionPrompts com não-boolean",
      mutate: (s) => setAtPath(s, "bypassesPermissionPrompts", "sim"),
      expect: ["`bypassesPermissionPrompts` must be a boolean", 'got "sim"'],
    },
    {
      name: "providers que não é array",
      mutate: () => {},
      expect: ["`providers` must be an array"],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      if (testCase.name === "providers que não é array") {
        const reason = parseProviderSpecs({ schemaVersion: 1, providers: "nope" }).rejected[0].reason;
        for (const fragment of testCase.expect) expect(reason).toContain(fragment);
        return;
      }
      const candidate = structuredClone(baseSpec()) as unknown as Record<string, unknown>;
      testCase.mutate(candidate);
      const parsed = parseProviderSpec(candidate);
      expect(parsed.ok).toBe(false);
      const reason = parsed.ok ? "" : parsed.reason;
      for (const fragment of testCase.expect) expect(reason).toContain(fragment);
    });
  }

  it("id duplicado no mesmo arquivo explica que o primeiro vence", () => {
    const reason = parseProviderSpecs({ schemaVersion: 1, providers: [baseSpec(), baseSpec()] }).rejected[0].reason;
    expect(reason).toContain("duplicate id");
    expect(reason).toContain("the first entry with this id wins");
  });

  it("raiz que não é objeto é recusada nomeando a raiz", () => {
    const reason = parseProviderSpecs([1, 2]).rejected[0].reason;
    expect(reason).toContain("the root of the file");
    expect(reason).toContain("must be a JSON object");
    expect(reason).toContain("got [1,2]");
  });

  it("a receita publicada segue passando pelo validador (a instrução não pode ser inválida)", () => {
    expect(parseProviderSpec(measuredProviderRecipes()[0]).ok).toBe(true);
    expect(getAtPath(providersConfigSchema(), "properties.providers.items.properties.baseArgs")).toBeDefined();
  });
});

// Um lembrete executável de que os nomes de arquivo não podem divergir do
// que o resto do módulo assume.
describe("nomes de arquivo", () => {
  it("o schema fica ao lado do providers.json, no mesmo userData", () => {
    const dir = "/tmp/exemplo-userdata";
    expect(providersSchemaPath(dir)).toBe(join(dir, PROVIDERS_SCHEMA_FILENAME));
    expect(providersConfigPath(dir)).toBe(join(dir, PROVIDERS_CONFIG_FILENAME));
    expect(PROVIDERS_SCHEMA_REF).toBe(`./${PROVIDERS_SCHEMA_FILENAME}`);
  });
});

// ---------------------------------------------------------------------------
// A DECLARAÇÃO DE SESSÃO (task 2ea0269f): `capacity.session.store`
//
// O anti-drift acima já prova, contra o SCHEMA, que cada obrigatoriedade e
// cada enum do store é recusada nomeando o campo. Aqui ficam as regras que
// não são nem `required` nem `enum` — as que recusam uma declaração
// sintaticamente válida mas que faria o leitor procurar no lugar errado.
// ---------------------------------------------------------------------------

describe("o store de sessão é declaração validada, não campo livre", () => {
  const FILES = {
    kind: "files",
    root: "~/.qa/projects/{cwd:slug}",
    pattern: "*.meta.json",
    id: { from: "fileName", strip: ".meta.json" },
    cwd: { from: "root" },
    time: { from: "mtime" },
  };

  it("aceita um store completo — e `read` AUSENTE sai ausente, não `read: undefined`", () => {
    const full = parseSessionStore({ ...FILES, read: { exists: "{id}.jsonl", content: { minBytes: 16 } } });
    expect(full.ok).toBe(true);
    if (full.ok) expect(full.value).toEqual({ ...FILES, read: { exists: "{id}.jsonl", content: { minBytes: 16 } } });

    // A diferença entre "não medido" e "medido e vazio" é o que o leitor
    // consulta para decidir a resposta (`null` × `{exists:false}`): o campo
    // ausente precisa continuar AUSENTE depois do parse.
    const noRead = parseSessionStore(FILES);
    expect(noRead.ok && "read" in noRead.value).toBe(false);
  });

  it("recusa `pattern` absoluto — é glob RELATIVO à raiz, e diz isso", () => {
    const parsed = parseSessionStore({ ...FILES, pattern: "/etc/*.jsonl" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("capacity.session.store.pattern");
      expect(parsed.reason).toContain("RELATIVE");
    }
  });

  it("recusa `read.exists` sem `{id}`: sem o id não há o que procurar", () => {
    const parsed = parseSessionStore({ ...FILES, read: { exists: "otimo.jsonl", content: { minBytes: 16 } } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("capacity.session.store.read.exists");
  });

  it("recusa `minBytes` zero ou negativo, e `strip` vazio no id por nome de arquivo", () => {
    const badFloor = parseSessionStore({ ...FILES, read: { exists: "{id}.jsonl", content: { minBytes: 0 } } });
    expect(badFloor.ok).toBe(false);
    if (!badFloor.ok) expect(badFloor.reason).toContain("capacity.session.store.read.content.minBytes");

    const badStrip = parseSessionStore({ ...FILES, id: { from: "fileName", strip: "" } });
    expect(badStrip.ok).toBe(false);
    if (!badStrip.ok) expect(badStrip.reason).toContain("capacity.session.store.id.strip");
  });

  it("recusa nome de coluna que viraria OUTRA consulta (aspa, espaço) — a régua é a do leitor", () => {
    const parsed = parseSessionStore({
      kind: "sqlite",
      db: "~/.qa/qa.db",
      discovery: { table: "sessions; DROP TABLE x", idColumn: "id", cwdColumn: "cwd", timeColumn: "at" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("capacity.session.store.discovery.table");
      expect(parsed.reason).toContain("SQL identifier");
    }
  });

  it("aceita id por `dirName` (sem strip) e cwd pelo blob do antigravity — os dois casos que não cabem na forma mais comum", () => {
    const byDir = parseSessionStore({ ...FILES, id: { from: "dirName" }, cwd: { from: "binaryWorkspaceUri" } });
    expect(byDir.ok).toBe(true);
    if (byDir.ok) expect(byDir.value).toMatchObject({ id: { from: "dirName" }, cwd: { from: "binaryWorkspaceUri" } });
  });
});
