import { describe, it, expect } from "vitest";
import { deriveRadialProviderItems, radialProviderTitle } from "../../src/renderer/src/radial-providers";

describe("deriveRadialProviderItems", () => {
  const PROVIDERS = ["bash", "claude", "codex", "cursor", "antigravity", "opencode"];

  it("marks every provider installed when nothing is reported missing", () => {
    // A prontidão entra junto (task 1777060e) e, SEM linha de disponibilidade,
    // o honesto é `unknown` — instalado e NÃO verificado, nunca "pronto".
    expect(deriveRadialProviderItems(PROVIDERS, [])).toEqual(
      PROVIDERS.map((id) => ({ id, installed: true, readiness: "unknown", readinessHint: null })),
    );
  });

  it("marks reported-missing providers as not installed", () => {
    const result = deriveRadialProviderItems(PROVIDERS, [{ id: "codex" }, { id: "cursor" }]);
    expect(result.map((p) => [p.id, p.installed, p.readiness])).toEqual([
      ["bash", true, "unknown"],
      ["claude", true, "unknown"],
      ["codex", false, "missing"],
      ["cursor", false, "missing"],
      ["antigravity", true, "unknown"],
      ["opencode", true, "unknown"],
    ]);
  });

  it("has no bash special-case — it reads installed straight off the missing set", () => {
    // In practice main/providers.ts's checkAgentAvailability never reports
    // bash as missing (it's excluded up front, not an installable CLI), so
    // this never happens live — the derivation itself just doesn't hardcode
    // that assumption; it trusts whatever `missing` says.
    const result = deriveRadialProviderItems(PROVIDERS, [{ id: "bash" }]);
    expect(result.find((p) => p.id === "bash")).toMatchObject({
      id: "bash",
      installed: false,
      readiness: "missing",
    });
  });

  it("`not-ready` continua INSTALADO (o item não é desabilitado) e carrega o comando declarado", () => {
    // A decisão da task 1777060e: dizer POR QUE não vai funcionar vale mais que
    // esconder o provider. Quem desabilita é `installed: false` — a prontidão
    // não desabilita nada, só informa (e o RadialMenu usa isto no `title`).
    const result = deriveRadialProviderItems(
      PROVIDERS,
      [],
      [
        { id: "opencode", readiness: "not-ready", readinessHint: "opencode auth login" },
        { id: "claude", readiness: "ready", readinessHint: null },
      ],
    );
    const oc = result.find((p) => p.id === "opencode");
    expect(oc).toEqual({
      id: "opencode",
      installed: true,
      readiness: "not-ready",
      readinessHint: "opencode auth login",
    });
    expect(result.find((p) => p.id === "claude")).toMatchObject({ readiness: "ready" });
    // O que NÃO tem linha declarada segue `unknown` — nunca "pronto" por omissão.
    expect(result.find((p) => p.id === "codex")).toMatchObject({
      readiness: "unknown",
      readinessHint: null,
    });
  });

  it("preserves the input provider order", () => {
    const reordered = ["opencode", "bash", "claude"];
    expect(deriveRadialProviderItems(reordered, []).map((p) => p.id)).toEqual(reordered);
  });
});

describe("radialProviderTitle — o que o dono VÊ (task 1777060e)", () => {
  /** Duble do tradutor: mostra CHAVE e variáveis, para a asserção falar do que
   *  a tela mostraria sem depender do texto exato do catálogo. */
  const t = (key: string, vars: { id: string; hint: string }) =>
    `${key}:${vars.id}${vars.hint === "" ? "" : `|${vars.hint}`}`;
  const item = (over: Partial<Parameters<typeof radialProviderTitle>[0]> = {}) => ({
    id: "claude",
    installed: true,
    readiness: "unknown" as const,
    readinessHint: null,
    ...over,
  });

  it("`unknown` NÃO vira texto — o radial fica exatamente como era antes (a pergunta do dono)", () => {
    // Todo provider NATIVO está em `unknown` (nenhum declara probe): converter
    // isto em texto encheria o radial inteiro de ruído.
    expect(radialProviderTitle(item(), t)).toBeNull();
  });

  it("`ready` também não vira texto — não há o que dizer de um provider que está pronto", () => {
    expect(radialProviderTitle(item({ readiness: "ready" }), t)).toBeNull();
  });

  it("só `not-ready` ganha frase, e ela carrega o comando DECLARADO pelo provider", () => {
    expect(radialProviderTitle(item({ readiness: "not-ready", readinessHint: "omp auth-broker login" }), t)).toBe(
      "radial.notReady:claude|omp auth-broker login",
    );
  });

  it("`not-ready` sem hint declarado usa a frase genérica (a UI não inventa comando)", () => {
    expect(radialProviderTitle(item({ readiness: "not-ready" }), t)).toBe("radial.notReadyNoHint:claude");
  });

  it("`missing` mantém a frase que JÁ existia antes desta task", () => {
    expect(radialProviderTitle(item({ installed: false, readiness: "missing" }), t)).toBe("radial.notInstalled:claude");
  });
});
