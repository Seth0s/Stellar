import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEASURED_THIRD_PARTY_SPECS,
  PROVIDERS_CONFIG_EXAMPLE,
  PROVIDERS_CONFIG_FILENAME,
  PROVIDERS_SCHEMA_FILENAME,
  PROVIDERS_SCHEMA_REF,
  ensureProvidersSchemaFile,
  initialProvidersConfig,
  initialProvidersConfigJson,
  loadDynamicProviders,
  parseProviderSpec,
  parseProviderSpecs,
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
    session: { canImposeSessionId: true, imposeFlag: "--id", resumeFlag: "--resume", continueFlag: "--continue" },
    systemPrompt: { mechanism: "flag", flag: "-s" },
    mcp: { mechanism: "global-config", configPath: "~/.x/mcp.json", configKey: "mcpServers", serverShape: "stdio-command" },
    acbridgeOnPath: true,
    effort: { mechanism: "flag", flag: "--effort", values: ["low", "high"] },
    model: { mechanism: "flag", flag: "-m" },
    delivery: { briefMechanism: "flag", briefFlag: "--prompt" },
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

const BASES = [MAX_FLAG, MAX_NONE];

describe("anti-drift: o schema publicado não pode divergir do parser", () => {
  it("as duas bases do teste são válidas pelo próprio validador", () => {
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
    expect(Object.keys(schema.properties)).toEqual(["$schema", "schemaVersion", "providers", "_example"]);
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(schema.properties.providers.items.properties.baseArgs.type).toBe("array");
    expect(schema.properties.providers.items.properties.baseArgs.items.minLength).toBe(1);
    // O efeito é DECLARADO no schema (task c857539c), com a exigência de
    // medição escrita na description — é o que deixa o dono declarar o
    // bypass da CLI DELE sem o Stellar deduzir string nenhuma.
    expect(schema.properties.providers.items.properties.bypassesPermissionPrompts.type).toBe("boolean");
    expect(schema.properties.providers.items.properties.bypassesPermissionPrompts.description).toContain("MEDIDO");
  });

  it("o efeito é DECLARADO, nunca deduzido: commandcode true (medido), cline e o exemplo sem claim", () => {
    const commandcode = MEASURED_THIRD_PARTY_SPECS.find((entry) => entry.id === "commandcode");
    expect(commandcode?.baseArgs).toEqual(["--yolo"]);
    expect(commandcode?.bypassesPermissionPrompts).toBe(true);
    // Sem medição, sem claim: cline não ganhou flag nem efeito.
    const cline = MEASURED_THIRD_PARTY_SPECS.find((entry) => entry.id === "cline");
    expect(cline?.bypassesPermissionPrompts).toBeUndefined();
    // E o exemplo publicado não ensina a declarar efeito sem medição.
    expect(PROVIDERS_CONFIG_EXAMPLE.bypassesPermissionPrompts).toBeUndefined();
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
// O arquivo inicial
// ---------------------------------------------------------------------------

describe("o arquivo inicial (primeiro save)", () => {
  it("não é um arquivo vazio: aponta o schema e traz o exemplo", () => {
    const initial = initialProvidersConfig();
    expect(initial.$schema).toBe(PROVIDERS_SCHEMA_REF);
    expect(initial.schemaVersion).toBe(1);
    expect(initial.providers).toEqual([]);
    expect(initial._example).toEqual(PROVIDERS_CONFIG_EXAMPLE);
  });

  it("o exemplo NÃO vira provider: `_example` está fora de `providers`", () => {
    const dir = freshDir();
    writeFileSync(providersConfigPath(dir), initialProvidersConfigJson(), "utf8");

    const loaded = loadDynamicProviders(dir, { shipped: [] });

    expect(loaded.fileRead).toBe(true);
    expect(loaded.error).toBeNull();
    expect(loaded.rejected).toEqual([]);
    expect(loaded.registered).toEqual([]);
    expect(loaded.removed).toEqual([]);
  });

  it("continua sendo um arquivo que o loader aceita mesmo com chaves extras (`$schema`, `_example`)", () => {
    const dir = freshDir();
    const withProvider = initialProvidersConfig();
    withProvider.providers = [PROVIDERS_CONFIG_EXAMPLE];
    writeFileSync(providersConfigPath(dir), `${JSON.stringify(withProvider, null, 2)}\n`, "utf8");

    const loaded = loadDynamicProviders(dir, { shipped: [] });
    expect(loaded.rejected).toEqual([]);
    expect(loaded.registered).toEqual([PROVIDERS_CONFIG_EXAMPLE.id]);
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

  it("arquivo inicial e exemplo seguem passando pelo validador (a instrução não pode ser inválida)", () => {
    expect(parseProviderSpec(PROVIDERS_CONFIG_EXAMPLE).ok).toBe(true);
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
