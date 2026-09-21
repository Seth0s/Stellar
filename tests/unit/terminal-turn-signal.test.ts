import { describe, it, expect } from "vitest";
import { readTurnEndSignal } from "../../src/renderer/src/terminal-turn-signal";
import { projectTurnEndSignal } from "../../src/main/agent-availability-projection";
import { providerById } from "../../src/main/providers";

/**
 * O FIM DE TURNO É DECLARADO, NÃO PERGUNTADO POR ID (task 0dd5c145).
 *
 * O que estes testes travam é o caminho inteiro: a DECLARAÇÃO do provider
 * (`capacity.delivery.turnEnd`, providers.ts) → a PROJEÇÃO do canal de
 * disponibilidade (a mesma que `agents:check-availability` manda) → o que o
 * terminal faz com ela. Antes disto a resposta era um `id === "claude"` no
 * renderer mais uma tabela ao lado, e as duas afirmavam "só claude e codex
 * sabem terminar um turno" — falso.
 */

/** O sinal que o renderer RECEBERIA para este provider, pela projeção real. */
function projectedFor(id: string) {
  return projectTurnEndSignal(providerById(id)?.capacity.delivery.turnEnd);
}

describe("readTurnEndSignal — quem consegue fechar um turno hoje", () => {
  it("claude fecha por EVENTO (hook), não por regex", () => {
    const reader = readTurnEndSignal(projectedFor("claude"));
    expect(reader.hasRealTurnSignal).toBe(true);
    expect(reader.pattern).toBeNull();
  });

  it("codex fecha pelo marcador de TELA — e o padrão vem DECLARADO, não do renderer", () => {
    const reader = readTurnEndSignal(projectedFor("codex"));
    expect(reader.hasRealTurnSignal).toBe(true);
    expect(reader.pattern?.test("Worked for 1m 06s")).toBe(true);
    expect(reader.pattern?.test("Worked for 8m 0s")).toBe(true);
  });

  it("ausência de declaração = não sinaliza, e a UI não promete", () => {
    for (const id of ["cursor", "antigravity", "opencode", "bash"]) {
      expect(projectedFor(id)).toBeNull();
      const reader = readTurnEndSignal(projectedFor(id));
      expect(reader.hasRealTurnSignal).toBe(false);
      expect(reader.pattern).toBeNull();
    }
  });

  it("provider sem projeção (CLI dinâmico sem declaração) também não sinaliza", () => {
    const reader = readTurnEndSignal(null);
    expect(reader.hasRealTurnSignal).toBe(false);
    expect(reader.pattern).toBeNull();
  });

  it("o padrão remontado é EQUIVALENTE ao declarado (RegExp não atravessa IPC)", () => {
    const declared = providerById("codex")?.capacity.delivery.turnEnd;
    if (declared?.mechanism !== "screen") throw new Error("codex deveria declarar um padrão de tela");
    const reader = readTurnEndSignal(projectTurnEndSignal(declared));
    // A MESMA frase, um match em cada: o `source`/`flags` que viaja não perde
    // nada na ida e volta.
    const samples = ["Worked for 1m 06s", "Worked for 8m 0s", "Thought for 1 second", "sem marcador"];
    for (const sample of samples) {
      expect(reader.pattern?.test(sample)).toBe(declared.pattern.test(sample));
    }
  });
});
