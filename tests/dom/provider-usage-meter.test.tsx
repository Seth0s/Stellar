import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ProviderUsageBadge } from "@renderer/ProviderUsageBadge";
import { USAGE_STALE_TTL_MS } from "@renderer/provider-usage-decision";
import { setLocale } from "../../src/shared/i18n";
import type { ProviderUsageStats } from "../../src/main/provider-usage";

/**
 * O DOM do medidor (task b7caf86d). Prova o que o desenho promete e o que o
 * dono cobrou explicitamente:
 *  - ausência ⇒ "não disponível", SEM barra e SEM "0%";
 *  - `0%` MEDIDO é barra de verdade (o par que separa ausência de zero);
 *  - o colapsado ABRE e mostra a IDADE do dado — e dado velho DIZ que é velho.
 *
 * Limite do jsdom (ver tests/dom/setup.ts): geometria mente, então aqui não se
 * prova largura de pixel — só o texto, os papéis e o estado do colapsado.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 2_000_000_000_000;

beforeEach(() => setLocale("pt-BR"));

function renderMeter(
  stats: ProviderUsageStats | undefined,
  opts: { nowMs?: number; onMeasure?: () => void } = {},
) {
  return render(
    <ProviderUsageBadge
      providerId="claude"
      stats={stats}
      nowMs={opts.nowMs ?? NOW}
      onMeasure={opts.onMeasure}
    />,
  );
}

const unavailable: ProviderUsageStats = {
  provider: "codex",
  supported: false,
  reason: "Codex CLI não expõe endpoint de uso",
};

describe("ProviderUsageBadge — o invariante da ausência", () => {
  it("leitura ausente mostra 'não disponível' e NENHUMA barra nem 0%", () => {
    renderMeter(undefined);
    expect(document.querySelector('[data-role="provider-usage-unavailable"]')?.textContent).toBe(
      "não disponível",
    );
    expect(document.querySelector('[data-role="provider-usage-bar"]')).toBeNull();
    expect(document.querySelector('[data-role="provider-usage-percent"]')).toBeNull();
  });

  it("indisponível (motivo do main) também é 'não disponível', nunca barra vazia", () => {
    renderMeter(unavailable);
    expect(document.querySelector('[data-role="provider-usage-unavailable"]')).toBeTruthy();
    expect(document.querySelector('[data-role="provider-usage-bar"]')).toBeNull();
  });

  it("o OPOSTO do invariante: 0% MEDIDO é barra em 0%, não 'não disponível'", () => {
    const zero: ProviderUsageStats = {
      provider: "claude",
      supported: true,
      source: "local-cache",
      segments: [{ key: "credits", percent: 0 }],
    };
    renderMeter(zero);
    const bar = document.querySelector('[data-role="provider-usage-bar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("0");
    expect(document.querySelector('[data-role="provider-usage-percent"]')?.textContent).toBe("0%");
    expect(document.querySelector('[data-role="provider-usage-unavailable"]')).toBeNull();
  });
});

describe("ProviderUsageBadge — o colapsado e a idade", () => {
  it("fechado não mostra detalhes; abrir MOSTRA a idade do dado", () => {
    const captured = NOW - 3 * DAY_MS;
    renderMeter({
      provider: "claude",
      supported: true,
      source: "local-cache",
      totalSessions: 25,
      capturedAtMs: captured,
    });

    expect(document.querySelector('[data-role="provider-usage-details"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-role="provider-usage-toggle"]')!);

    const details = document.querySelector('[data-role="provider-usage-details"]');
    expect(details).toBeTruthy();
    const age = document.querySelector('[data-role="provider-usage-age"]');
    // A idade é um NÚMERO, não um rótulo vazio: "Capturado há 3 dias".
    expect(age?.textContent).toContain("Capturado");
    expect(age?.textContent ?? "").toMatch(/\d/);
  });

  it("dado além do TTL DIZ que é velho; dado fresco não ganha a marca", () => {
    const stale = NOW - USAGE_STALE_TTL_MS - 1;
    const { unmount } = renderMeter(
      { provider: "claude", supported: true, source: "local-cache", capturedAtMs: stale },
      { nowMs: NOW },
    );
    fireEvent.click(document.querySelector('[data-role="provider-usage-toggle"]')!);
    expect(document.querySelector('[data-role="provider-usage-stale"]')).toBeTruthy();
    unmount();

    const fresh = NOW - 60_000;
    renderMeter(
      { provider: "claude", supported: true, source: "local-cache", capturedAtMs: fresh },
      { nowMs: NOW },
    );
    fireEvent.click(document.querySelector('[data-role="provider-usage-toggle"]')!);
    expect(document.querySelector('[data-role="provider-usage-stale"]')).toBeNull();
  });

  it("sem `capturedAt` o colapsado NÃO inventa idade", () => {
    renderMeter({ provider: "opencode", supported: true, source: "cli-stats", totalSessions: 3 });
    fireEvent.click(document.querySelector('[data-role="provider-usage-toggle"]')!);
    expect(document.querySelector('[data-role="provider-usage-details"]')).toBeTruthy();
    expect(document.querySelector('[data-role="provider-usage-age"]')).toBeNull();
  });
});

describe("ProviderUsageBadge — o gesto explícito de medir", () => {
  it("o botão só aparece para fonte SOB DEMANDA declarada, e dispara o callback", () => {
    const onDemand: ProviderUsageStats = {
      provider: "opencode",
      supported: false,
      reason: "fonte cara",
      onDemand: true,
    };
    let called = 0;
    renderMeter(onDemand, { onMeasure: () => (called += 1) });
    fireEvent.click(document.querySelector('[data-role="provider-usage-toggle"]')!);
    const button = document.querySelector('[data-role="provider-usage-measure"]')!;
    fireEvent.click(button);
    expect(called).toBe(1);
  });

  it("fonte que NÃO declara onDemand não oferece o botão", () => {
    renderMeter(unavailable, { onMeasure: () => {} });
    fireEvent.click(document.querySelector('[data-role="provider-usage-toggle"]')!);
    expect(document.querySelector('[data-role="provider-usage-measure"]')).toBeNull();
  });
});
