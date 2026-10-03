import { describe, expect, it } from "vitest";
import {
  decideProviderUsage,
  formatTokenMetric,
  USAGE_STALE_TTL_MS,
} from "../../src/renderer/src/provider-usage-decision";
import type { ProviderUsageStats } from "../../src/main/provider-usage";

/**
 * A decisão PURA da UI de uso/cota (task b7caf86d). Os dois invariantes que o
 * dono pediu como prova, e que uma regressão futura tende a quebrar:
 *
 *  1. o PAR DE CONTROLE — percentual presente ⇒ barra; ausente ⇒ sem barra;
 *  2. o caso que SEPARA ausente de ZERO — `percent: 0` medido É barra,
 *     "nenhum segmento" NÃO é. Coagir ausência a 0 seria uma medição falsa.
 */

type Measured = Extract<ProviderUsageStats, { supported: true }>;

function stats(over: Partial<Measured> = {}): ProviderUsageStats {
  return { provider: "claude", supported: true, source: "local-cache", ...over };
}

function measuredView(input: ProviderUsageStats | undefined, nowMs = 1_000) {
  const view = decideProviderUsage({ stats: input, nowMs });
  if (view.kind !== "measured") throw new Error(`esperava measured, veio ${view.kind}`);
  return view;
}

function unavailableView(input: ProviderUsageStats | undefined, nowMs = 1_000) {
  const view = decideProviderUsage({ stats: input, nowMs });
  if (view.kind !== "unavailable") throw new Error(`esperava unavailable, veio ${view.kind}`);
  return view;
}

describe("decideProviderUsage — o par de CONTROLE da barra", () => {
  it("percentual MEDIDO presente ⇒ UMA barra com o valor", () => {
    const view = measuredView(stats({ segments: [{ key: "session", percent: 42 }] }));
    expect(view.bars).toHaveLength(1);
    expect(view.bars[0]).toMatchObject({
      key: "session",
      percent: 42,
      labelKey: "usage.segment.session",
    });
  });

  it("percentual AUSENTE ⇒ NENHUMA barra (não há o que preencher)", () => {
    expect(measuredView(stats()).bars).toEqual([]);
  });

  it("SEPARA ausente de ZERO: 0% medido É barra; sem segmento NÃO é", () => {
    const zero = measuredView(stats({ segments: [{ key: "credits", percent: 0 }] }));
    const none = measuredView(stats());
    // A barra existe e está em 0 — medição real.
    expect(zero.bars).toHaveLength(1);
    expect(zero.bars[0].percent).toBe(0);
    // E o vazio é vazio, não um 0 disfarçado.
    expect(none.bars).toEqual([]);
  });

  it("percentual não-finito é DESCARTADO, nunca coagido a 0", () => {
    const view = measuredView(stats({ segments: [{ key: "session", percent: Number.NaN }] }));
    expect(view.bars).toEqual([]);
  });

  it("percentual fora de 0..100 é preso ao intervalo (fonte suja não vaza para a largura)", () => {
    expect(measuredView(stats({ segments: [{ key: "session", percent: 140 }] })).bars[0].percent).toBe(100);
    expect(measuredView(stats({ segments: [{ key: "session", percent: -5 }] })).bars[0].percent).toBe(0);
  });

  it("segmento de janela desconhecida ainda tem rótulo (nunca uma barra muda)", () => {
    expect(measuredView(stats({ segments: [{ key: "exotica", percent: 10 }] })).bars[0].labelKey).toBe(
      "usage.segment.other",
    );
  });
});

describe("decideProviderUsage — ausência nunca vira número", () => {
  it("leitura AUSENTE ⇒ unavailable, sem barra", () => {
    const view = unavailableView(undefined);
    expect(view.reason).toBeNull();
    expect(view.dashboardUrl).toBeUndefined();
  });

  it("indisponível carrega o motivo do MAIN (fonte única) e o dashboard", () => {
    expect(
      unavailableView({
        provider: "codex",
        supported: false,
        reason: "sem numero exposto",
        dashboardUrl: "https://example.test/usage",
      }),
    ).toMatchObject({
      kind: "unavailable",
      reason: "sem numero exposto",
      dashboardUrl: "https://example.test/usage",
    });
  });
});

describe("decideProviderUsage — idade e `stale`", () => {
  const captured = 1_000_000;

  it("dentro do TTL: não é velho, e a idade EXATA sai em `ageMs`", () => {
    const view = measuredView(stats({ capturedAtMs: captured }), captured + 60_000);
    expect(view.ageMs).toBe(60_000);
    expect(view.stale).toBe(false);
  });

  it("além do TTL: velho — e a idade continua exata (a cor não substitui o número)", () => {
    const nowMs = captured + USAGE_STALE_TTL_MS + 1;
    const view = measuredView(stats({ capturedAtMs: captured }), nowMs);
    expect(view.stale).toBe(true);
    expect(view.ageMs).toBe(USAGE_STALE_TTL_MS + 1);
  });

  it("sem `capturedAt` não existe idade nem stale — ausência honesta, nunca 0s", () => {
    const view = measuredView(stats(), captured);
    expect(view.ageMs).toBeNull();
    expect(view.stale).toBe(false);
  });
});

describe("decideProviderUsage — métricas do colapsado", () => {
  it("monta as linhas presentes e omite as ausentes (não inventa zero)", () => {
    const view = measuredView(
      stats({ costUSD: 1.5, inputTokens: 70_000, totalSessions: 25, totalMessages: 1000 }),
    );
    const keys = view.metrics.map((row) => row.key);
    expect(keys).toEqual(["cost", "input", "sessions", "messages"]);
    expect(view.metrics.find((row) => row.key === "cost")?.text).toBe("$1.50");
    expect(view.metrics.find((row) => row.key === "input")?.text).toBe("70.0k");
  });

  it("cache read só entra quando é > 0 (o zero do opencode não vira linha)", () => {
    expect(measuredView(stats({ cacheReadTokens: 0 })).metrics.map((m) => m.key)).not.toContain("cacheRead");
    expect(measuredView(stats({ cacheReadTokens: 500 })).metrics.map((m) => m.key)).toContain("cacheRead");
  });
});

describe("formatTokenMetric (re-exportado pelo badge)", () => {
  it("notação curta", () => {
    expect(formatTokenMetric(0)).toBe("0");
    expect(formatTokenMetric(500)).toBe("500");
    expect(formatTokenMetric(1500)).toBe("1.5k");
    expect(formatTokenMetric(2_400_000)).toBe("2.4M");
    expect(formatTokenMetric(1_500_000_000)).toBe("1.5B");
  });
});
