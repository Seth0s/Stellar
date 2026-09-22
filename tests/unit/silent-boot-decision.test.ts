import { describe, it, expect } from "vitest";
import { FIRST_OUTPUT_DEADLINE_MS, decideSilentBoot } from "../../src/main/silent-boot-decision";

/**
 * O limite de PRIMEIRA SAÍDA (task d77b524b) — "o card subiu e nunca falou".
 *
 * A decisão é pura e minúscula de propósito: AVISAR (nunca matar, por decisão do
 * dono), uma vez, e só com fato suficiente. O número (30 s) sai da medição no
 * doc do módulo: máximo observado 6627 ms, mediana ≈2,2 s.
 */
describe("silent boot — decidir avisar", () => {
  const base = { alive: true, hasReceivedOutput: false, msSinceSpawn: FIRST_OUTPUT_DEADLINE_MS };

  it("passou do limite sem NENHUM byte: avisa", () => {
    expect(decideSilentBoot(base)).toEqual({ action: "notify" });
    expect(decideSilentBoot({ ...base, msSinceSpawn: FIRST_OUTPUT_DEADLINE_MS * 3 })).toEqual({ action: "notify" });
  });

  it("um byte que seja já é saída — não avisa (a moldura do TUI conta)", () => {
    expect(decideSilentBoot({ ...base, hasReceivedOutput: true })).toEqual({
      action: "skip",
      reason: "already-spoke",
    });
  });

  it("dentro da janela não avisa: o CLI tem o direito de demorar até o limite", () => {
    expect(decideSilentBoot({ ...base, msSinceSpawn: FIRST_OUTPUT_DEADLINE_MS - 1 })).toEqual({
      action: "skip",
      reason: "within-window",
    });
    // o máximo MEDIDO (6627 ms) fica folgado dentro da janela
    expect(decideSilentBoot({ ...base, msSinceSpawn: 6_627 })).toEqual({ action: "skip", reason: "within-window" });
  });

  it("card morto não vira aviso (a saída sem report já tem o SINAL 2)", () => {
    expect(decideSilentBoot({ ...base, alive: false })).toEqual({ action: "skip", reason: "not-alive" });
  });

  it("idade desconhecida NÃO vira aviso: sem fato, não se inventa acusação", () => {
    expect(decideSilentBoot({ ...base, msSinceSpawn: null })).toEqual({ action: "skip", reason: "unknown-age" });
  });

  it("o limite é 4× o pior primeiro byte medido — a margem fica pinada com a medição", () => {
    const piorMedidoMs = 6_627;
    expect(FIRST_OUTPUT_DEADLINE_MS).toBeGreaterThanOrEqual(piorMedidoMs * 4);
  });
});
