import { describe, it, expect } from "vitest";
import { buildProviderGroups } from "../../src/renderer/src/provider-groups";
import type { AgentAvailability } from "../../src/renderer/src/useAgentAvailability";

/**
 * A classificação nativo × genérico é a do MAIN (`main/providers.ts`'s
 * `dynamicProviderIds`, como `providers-dynamic.ts` a sincroniza). Estes
 * testes fixam só a CONSUMA — em especial a regra da SOMBRA: id genérico
 * igual ao de um nativo perde (o nativo ganha, `registerDynamicProviders`
 * recusa e nomeia em `skipped`), então a UI não pode mostrar dois itens.
 */
function availability(ids: string[], installed: string[] = []): AgentAvailability[] {
  return ids.map((id) => ({
    id,
    label: id === "claude" ? "Claude" : id.toUpperCase(),
    installed: installed.includes(id),
    installCommand: null,
  }));
}

const NATIVE_AGENTS = ["claude", "codex", "cursor", "antigravity", "opencode"];

describe("buildProviderGroups", () => {
  it("sem genérico registrado, tudo é nativo — e nada é inventado", () => {
    const groups = buildProviderGroups({
      orderedIds: ["bash", ...NATIVE_AGENTS],
      available: availability(NATIVE_AGENTS),
      dynamicIds: [],
      skippedIds: [],
    });

    expect(groups.generic).toEqual([]);
    expect(groups.shadowed).toEqual([]);
    expect(groups.native.map((option) => option.id)).toEqual(["bash", ...NATIVE_AGENTS]);
    expect(groups.native.every((option) => option.klass === "native")).toBe(true);
  });

  it("id que o loader registrou pelo caminho dinâmico vira GENÉRICO", () => {
    const groups = buildProviderGroups({
      orderedIds: ["bash", ...NATIVE_AGENTS, "cline", "commandcode"],
      available: availability([...NATIVE_AGENTS, "cline", "commandcode"]),
      dynamicIds: ["cline", "commandcode"],
      skippedIds: [],
    });

    expect(groups.generic.map((option) => option.id)).toEqual(["cline", "commandcode"]);
    expect(groups.native.map((option) => option.id)).toEqual(["bash", ...NATIVE_AGENTS]);
  });

  it("sombra: id genérico igual ao de um nativo aparece UMA vez, como nativo marcado", () => {
    const groups = buildProviderGroups({
      orderedIds: ["bash", "claude"],
      available: availability(["claude"], ["claude"]),
      dynamicIds: ["claude"],
      skippedIds: ["claude"],
    });

    expect(groups.native).toEqual([
      { id: "bash", label: "bash", installed: true, klass: "native", shadowed: false },
      { id: "claude", label: "Claude", installed: true, klass: "native", shadowed: true },
    ]);
    // Nem "dois claude": o genérico declarado é INERTE (o nativo ganha).
    expect(groups.generic).toEqual([]);
    expect(groups.shadowed).toEqual(["claude"]);
  });

  it("um skipped id que não está na lista oferecida não vira item fantasma", () => {
    const groups = buildProviderGroups({
      orderedIds: ["bash", "claude"],
      available: availability(["claude"]),
      dynamicIds: ["claude"],
      skippedIds: ["claude"],
    });

    expect(groups.native).toHaveLength(2);
    expect(groups.generic).toHaveLength(0);
  });

  it("preserva a ordem de `orderedIds` dentro de cada grupo", () => {
    const groups = buildProviderGroups({
      orderedIds: ["opencode", "cline", "bash", "commandcode", "claude"],
      available: availability(["opencode", "claude", "cline", "commandcode"]),
      dynamicIds: ["cline", "commandcode"],
      skippedIds: [],
    });

    expect(groups.native.map((option) => option.id)).toEqual(["opencode", "bash", "claude"]);
    expect(groups.generic.map((option) => option.id)).toEqual(["cline", "commandcode"]);
  });

  it("rótulo declarado vem do registro; sem entrada (ex.: bash), cai no próprio id", () => {
    const groups = buildProviderGroups({
      orderedIds: ["bash", "claude"],
      available: availability(["claude"], []),
      dynamicIds: [],
      skippedIds: [],
    });

    expect(groups.native.find((option) => option.id === "bash")?.label).toBe("bash");
    expect(groups.native.find((option) => option.id === "claude")?.label).toBe("Claude");
  });

  it("propaga `installed` do canal de disponibilidade", () => {
    const groups = buildProviderGroups({
      orderedIds: ["claude", "codex"],
      available: availability(["claude", "codex"], ["claude"]),
      dynamicIds: [],
      skippedIds: [],
    });

    expect(groups.native.find((option) => option.id === "claude")?.installed).toBe(true);
    expect(groups.native.find((option) => option.id === "codex")?.installed).toBe(false);
  });
});
