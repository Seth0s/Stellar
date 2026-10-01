import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PROVIDERS } from "../../src/main/providers";
import { decideSpawnProfile } from "../../src/main/spawn-profile-decision";

/**
 * O EFFORT DO ANTIGRAVITY ENVELHECEU POR VERSÃO (task 1c4f3b50).
 *
 * O ACHADO: a doc citava a v1.2.2 e o `--help` da v1.2.14 passou a anunciar
 * `low|medium|high|max`. O repo exige MEDIR o runtime — help não é prova.
 * Medido em 2026-10-01 (agy v1.2.14), a faixa é POR MODELO:
 *   - default (`gemini-3.1-pro`, sem `--model`): `low`/`high` OK (exit 0);
 *     `medium` e `max` saem exit 1 ("has no medium/max effort (available:
 *     low, high)");
 *   - `medium` é honrado por modelo cujo NOME carrega o nível
 *     (`gemini-3.8-flash-medium --effort medium` → exit 0);
 *   - `max` NÃO é honrado por modelo NENHUM (todo `--effort max` erra).
 *
 * DECISÃO: `max` NÃO entra na declaração (nada o honra). `low|medium|high`
 * ficam (os níveis que a CLI aceita), com a ressalva do `medium` registrada no
 * comentário de `EffortCapability`. Este teste amarra a declaração à evidência
 * literal (`fixtures`, saída real com exit code): se o agy mudar as
 * flags/ranges, ele cai com o texto real na mão.
 */
const fx = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/antigravity-effort/${name}.json`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

const antigravity = PROVIDERS.find((p) => p.id === "antigravity")!;
const effort = antigravity.capacity.effort;

describe("agy v1.2.14 — `--effort` medido em runtime (task 1c4f3b50)", () => {
  it("a declaração NÃO inclui `max` — nada o honra; mantém low/medium/high", () => {
    expect(effort).toEqual({ mechanism: "flag", flag: "--effort", values: ["low", "medium", "high"] });
    expect(effort.mechanism === "flag" && effort.values).not.toContain("max");
  });

  it("`max` é ERROR em TODA execução registrada (default e com modelo)", () => {
    for (const name of ["default-max", "flash-medium-effort-max", "flash-low-effort-max"]) {
      expect(fx(name).status, name).toBe("ERROR");
    }
    // Sem modelo: o modelo default não tem a faixa `max`.
    expect(String(fx("default-max").error)).toContain('has no "max" effort');
    // Com modelo: o nível do nome conflita com o `max` pedido — também erro.
    expect(String(fx("flash-medium-effort-max").error)).toContain("conflicts with --effort=max");
  });

  it("`low` e `high` são honrados pelo default (exit 0, com a resposta real)", () => {
    for (const v of ["low", "high"]) {
      const out = fx(`default-${v}`);
      expect(out.status, `--effort ${v}`).toBe("SUCCESS");
      expect(out.response).toBe("60\n");
    }
  });

  it("o validador GLOBAL anuncia `max` — a divergência help-vs-runtime que o teste registra", () => {
    const err = String(fx("invalid-bogus").error);
    expect(err).toContain("invalid --effort");
    expect(err).toContain("valid: low, medium, high, max");
  });

  it("RESSALVA registrada: `medium` NÃO é honrado pelo default, mas É por um modelo que carrega o nível", () => {
    expect(fx("default-medium").status).toBe("ERROR");
    expect(String(fx("default-medium").error)).toContain('has no "medium" effort');
    expect(fx("flash-medium-effort-medium").status).toBe("SUCCESS");
  });

  it("o gate concorda com a declaração: a faixa passa; `max` é RECUSADO antes de nascer card", () => {
    for (const v of ["low", "medium", "high"]) {
      expect(decideSpawnProfile({ providerId: "antigravity", effort: v })).toEqual({ ok: true });
    }
    const refused = decideSpawnProfile({ providerId: "antigravity", effort: "max" });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.field).toBe("effort");
    expect(refused.ok === false && refused.error).toContain('only accepts effort "low", "medium", or "high"');
  });
});
