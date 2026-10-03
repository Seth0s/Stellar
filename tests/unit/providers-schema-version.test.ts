import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerById } from "../../src/main/providers";
import {
  PROVIDERS_CONFIG_SCHEMA_VERSION,
  classifyProvidersSchemaVersion,
  ensureProvidersConfigFile,
  loadDynamicProviders,
  parseProviderSpecs,
  providersConfigPath,
  providersConfigSchema,
  providersSchemaVersionRefusal,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";

/**
 * A VERSÃO DO FORMATO DO ARQUIVO (task 88a3d004).
 *
 * O buraco medido: `schemaVersion` existia e era comparado com `!== 1` num
 * único lugar, então MENOR e MAIOR caíam na MESMA recusa genérica — sem
 * direção e sem instrução. Hoje só a versão 1 existiu, então NÃO há migração
 * (a tabela versão→transform nasceria vazia; inventar degraus é valor
 * inventado). A decisão é RECUSAR nomeando a versão, com respostas diferentes
 * para os dois sentidos.
 *
 * O contrato que NÃO pode regredir — e é repetido aqui nos DOIS sentidos,
 * além de travado em `providers-dynamic-prune.test.ts` para a versão
 * desconhecida: um formato que este build não entende NUNCA poda o registro
 * do usuário. E a frase-base da recusa (`must be the number 1`) continua
 * intacta para o anti-drift de `providers-dynamic-json-contract.test.ts`.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellar-schemav-"));
  dirs.push(dir);
  return dir;
}

function spec(id: string): DynamicProviderSpec {
  return {
    id,
    label: id,
    binaryNames: [id],
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

/** Escreve o arquivo com a versão pedida e devolve o TEXTO exato escrito, para
 * o teste comparar byte a byte depois (o arquivo não pode ser tocado). */
function writeVersionFile(dir: string, schemaVersion: unknown, providers: unknown[] = []): string {
  const text = `${JSON.stringify({ schemaVersion, providers }, null, 2)}\n`;
  writeFileSync(providersConfigPath(dir), text, "utf8");
  return text;
}

describe("classifyProvidersSchemaVersion — a decisão pura", () => {
  it("separa atual, MENOR, MAIOR e inválido", () => {
    expect(classifyProvidersSchemaVersion(1)).toBe("current");
    expect(classifyProvidersSchemaVersion(0)).toBe("older");
    expect(classifyProvidersSchemaVersion(-3)).toBe("older");
    expect(classifyProvidersSchemaVersion(2)).toBe("newer");
    expect(classifyProvidersSchemaVersion(99)).toBe("newer");
    expect(classifyProvidersSchemaVersion(undefined)).toBe("invalid");
    expect(classifyProvidersSchemaVersion(null)).toBe("invalid");
    expect(classifyProvidersSchemaVersion("1")).toBe("invalid");
    expect(classifyProvidersSchemaVersion(1.5)).toBe("invalid");
    expect(classifyProvidersSchemaVersion(NaN)).toBe("invalid");
  });
});

describe("a recusa nomeia a versão e a DIREÇÃO (fábrica única: refusal)", () => {
  it("MENOR: diz formato antigo, que não há transform, e a CONSEQUÊNCIA de apagar", () => {
    const reason = providersSchemaVersionRefusal(0);
    expect(reason).toContain("`schemaVersion` must be the number 1");
    expect(reason).toContain("got 0");
    expect(reason).toContain("OLDER format");
    expect(reason).toContain("no transform");
    expect(reason).toContain("left untouched");
    expect(reason).toContain("Delete it");
    expect(reason).toContain("`providers` entries would be lost");
  });

  it("MAIOR: caso DISTINTO — manda ATUALIZAR O APP, e não fala em formato antigo", () => {
    const reason = providersSchemaVersionRefusal(99);
    expect(reason).toContain("`schemaVersion` must be the number 1");
    expect(reason).toContain("got 99");
    expect(reason).toContain("NEWER Stellar");
    expect(reason).toContain("update the app");
    expect(reason).not.toContain("OLDER format");
  });

  it("AUSENTE/inválido: a frase-base, com o valor recebido", () => {
    expect(providersSchemaVersionRefusal(undefined)).toContain("got absent");
    // Um valor de forma errada não inventa direção: cai na frase-base.
    expect(providersSchemaVersionRefusal("1")).not.toContain("OLDER format");
    expect(providersSchemaVersionRefusal("1")).not.toContain("NEWER Stellar");
  });
});

describe("parseProviderSpecs: recusa de ARQUIVO com a direção, sem aplicar nada", () => {
  it("arquivo MENOR não aplica nenhum spec (recusa de index -1, a que não poda)", () => {
    const result = parseProviderSpecs({ schemaVersion: 0, providers: [spec("qa-schemav-old")] });
    expect(result.specs).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].index).toBe(-1);
    expect(result.rejected[0].reason).toContain("OLDER format");
  });

  it("arquivo MAIOR não aplica nenhum spec, e a recusa é distinta", () => {
    const result = parseProviderSpecs({ schemaVersion: 99, providers: [spec("qa-schemav-new")] });
    expect(result.specs).toEqual([]);
    expect(result.rejected[0].index).toBe(-1);
    expect(result.rejected[0].reason).toContain("NEWER Stellar");
  });
});

describe("o contrato de NÃO-PODAR vale nos DOIS sentidos", () => {
  it("arquivo MENOR não derruba um provider registrado", () => {
    const dir = freshDir();
    writeVersionFile(dir, 1, [spec("qa-schemav-old-prune")]);
    loadDynamicProviders(dir, { shipped: [] });
    expect(providerById("qa-schemav-old-prune")).toBeDefined();

    writeVersionFile(dir, 0, []);
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.error).toBeNull();
    expect(result.rejected.some((entry) => entry.index === -1)).toBe(true);
    expect(result.removed).not.toContain("qa-schemav-old-prune");
    expect(providerById("qa-schemav-old-prune")).toBeDefined();
  });

  it("arquivo MAIOR não derruba um provider registrado", () => {
    const dir = freshDir();
    writeVersionFile(dir, 1, [spec("qa-schemav-new-prune")]);
    loadDynamicProviders(dir, { shipped: [] });
    expect(providerById("qa-schemav-new-prune")).toBeDefined();

    writeVersionFile(dir, 99, []);
    const result = loadDynamicProviders(dir, { shipped: [] });

    expect(result.error).toBeNull();
    expect(result.removed).not.toContain("qa-schemav-new-prune");
    expect(providerById("qa-schemav-new-prune")).toBeDefined();
  });
});

describe("ensureProvidersConfigFile: formato divergente não é escrito (backup não é necessário)", () => {
  it("MENOR e MAIOR: action unsupported, arquivo BYTE a BYTE intocado, textos distintos", () => {
    const cases: [number, string][] = [
      [0, "OLDER"],
      [99, "NEWER"],
    ];
    for (const [version, needle] of cases) {
      const dir = freshDir();
      const before = writeVersionFile(dir, version, [spec(`qa-schemav-unsup-${version}`)]);

      const result = ensureProvidersConfigFile(dir, { shipped: [] });

      expect(result.action).toBe("unsupported");
      expect(result.error).toContain(needle);
      // A prova de reversibilidade: como nada é escrito, o arquivo é idêntico.
      expect(readFileSync(providersConfigPath(dir), "utf8")).toBe(before);
    }
  });
});

describe("o schema publicado documenta as duas direções e segue exigindo só a versão atual", () => {
  it("schemaVersion continua `const` da versão atual", () => {
    const schema = providersConfigSchema() as Record<string, any>;
    expect(schema.properties.schemaVersion.const).toBe(PROVIDERS_CONFIG_SCHEMA_VERSION);
  });

  it("a descrição diz MENOR/MAIOR e que o arquivo é RECUSADO, não migrado", () => {
    const schema = providersConfigSchema() as Record<string, any>;
    const description: string = schema.properties.schemaVersion.description;
    expect(description).toContain("MENOR");
    expect(description).toContain("MAIOR");
    expect(description).toContain("RECUSADA");
    expect(description).toContain("intocado");
  });
});
