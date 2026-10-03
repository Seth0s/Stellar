import { describe, expect, it } from "vitest";
import {
  PROVIDERS_CONFIG_SCHEMA_VERSION,
  dynamicProviderDef,
  parseProviderSpecs,
  shippedProviderSpecs,
  type DynamicProviderSpec,
} from "../../src/main/providers-dynamic";

/**
 * Task 2e1bc3be — `urlSyntax` no catálogo GENÉRICO.
 *
 * Era o único campo que o nativo do `opencode` tinha e o genérico NÃO sabia
 * declarar: sem ele `declaredUrlSyntax` cai no fallback `dollar-env`, o
 * opencode recebe `${env:}` e RECUSA com "Invalid MCP URL" — derrubando o
 * zero-processo (http-direto) que a task cita como a vantagem do genérico.
 *
 * Este teste prova que o genérico passa a EXPRESSAR a sintaxe. Ele NÃO remove o
 * nativo: a remoção exige antes a forma `{type:"remote"}` no
 * `MCP_SERVER_SHAPES` (mcp-registration.ts, fora do território).
 */

/** Spec base = a do `commandcode` (embarcada), clonada e com o mcp trocado. */
function specWith(mcp: DynamicProviderSpec["capacity"]["mcp"]): DynamicProviderSpec {
  const base = structuredClone(shippedProviderSpecs().find((s) => s.id === "commandcode")!);
  base.capacity.mcp = mcp;
  return base;
}
const wrap = (spec: DynamicProviderSpec) => ({
  schemaVersion: PROVIDERS_CONFIG_SCHEMA_VERSION,
  providers: [spec],
});

describe("urlSyntax no provider genérico (task 2e1bc3be)", () => {
  it("aceita brace-env e o campo SOBREVIVE ao mapeamento para o ProviderDef", () => {
    const parsed = parseProviderSpecs(
      wrap(
        specWith({
          mechanism: "global-config",
          configPath: "~/.config/opencode/opencode.json",
          configKey: "mcp",
          serverShape: "stdio-command",
          urlSyntax: "brace-env",
        }),
      ),
      {},
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.specs[0]!.capacity.mcp).toMatchObject({ urlSyntax: "brace-env" });
    // O DEF (o que `declaredUrlSyntax` lê no registro vivo) também carrega.
    const def = dynamicProviderDef(parsed.specs[0]!);
    expect(def.capacity.mcp).toMatchObject({ mechanism: "global-config", urlSyntax: "brace-env" });
  });

  it("AUSENTE = a CLI aceita o default; nada é inventado", () => {
    const parsed = parseProviderSpecs(
      wrap(
        specWith({
          mechanism: "global-config",
          configPath: "~/.x/mcp.json",
          configKey: "mcpServers",
          serverShape: "stdio-command",
        }),
      ),
      {},
    );
    expect(parsed.rejected).toEqual([]);
    expect("urlSyntax" in parsed.specs[0]!.capacity.mcp).toBe(false);
  });

  it("valor NÃO medido é RECUSADO nomeando o campo (nunca um palpite)", () => {
    const parsed = parseProviderSpecs(
      wrap(
        specWith({
          mechanism: "global-config",
          configPath: "~/.x/mcp.json",
          configKey: "mcpServers",
          serverShape: "stdio-command",
          urlSyntax: "weird-env" as never,
        }),
      ),
      {},
    );
    expect(parsed.specs).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0]!.reason).toContain("capacity.mcp.urlSyntax");
  });
});
