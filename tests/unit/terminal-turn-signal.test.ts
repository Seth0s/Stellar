import { describe, it, expect } from "vitest";
import {
  TURN_END_BUFFER_MAX,
  feedTurnEndChunk,
  readTurnEndSignal,
} from "../../src/renderer/src/terminal-turn-signal";
import { projectTurnEndSignal } from "../../src/main/agent-availability-projection";
import { providerById } from "../../src/main/providers";
import { decideTerminalActivity, initialTerminalActivity } from "../../src/renderer/src/terminal-activity-decision";

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

/**
 * O CARD PRESO EM "running" (task 238388cc, 2026-10-03).
 *
 * MEDIDO num PTY isolado com o CLI real (`commandcode` v1.74.1, provider
 * GENÉRICO): o turno fecha com `✻ Worked for 14s` e a regex DECLARADA casa. O
 * sinal EXISTE e é lido — o que falhava era a JANELA do renderer, que cortava
 * ANTES de testar. No stream real o marcador ficou a **460 chars do fim de um
 * chunk de 574** (maior chunk medido: **2214**), então qualquer coisa depois
 * dele passando de `TURN_END_BUFFER_MAX` no MESMO frame o descartava: sem
 * `turn_complete`, `signalProven` fica falso e CADA byte relâmpa a barra
 * re-armando o timer — a "animação que nunca para".
 */
const DECLARED = "Worked for (?:\\d+h\\s*)?(?:\\d+m\\s*)?\\d+(?:s| seconds?)";

describe("(A) feedTurnEndChunk — o marcador não pode ser cortado antes do teste", () => {
  it("o marcador REAL do commandcode casa com a regex declarada", () => {
    expect(feedTurnEndChunk("", "\x1b[38;5;60m✻ Worked for 14s\x1b[39m", new RegExp(DECLARED)).matched).toBe(true);
  });

  it("A REGRESSÃO: marcador no meio de um frame GRANDE (o corte antigo perdia)", () => {
    const pattern = new RegExp(DECLARED);
    // Forma real medida: depois do marcador ainda vêm centenas de chars do
    // MESMO frame (o rodapé do TUI). Aqui, > TURN_END_BUFFER_MAX.
    const chunk = `prefixo ✻ Worked for 6s ${"x".repeat(900)}`;
    expect(chunk.length).toBeGreaterThan(TURN_END_BUFFER_MAX);

    // O algoritmo ANTIGO (corta e só então testa) — documentado, para o defeito
    // não voltar em silêncio.
    expect(pattern.test(chunk.slice(-TURN_END_BUFFER_MAX))).toBe(false);

    // O NOVO: testa o chunk inteiro e só então encolhe.
    expect(feedTurnEndChunk("", chunk, pattern)).toEqual({ matched: true, tail: "" });
  });

  it("marcador PARTIDO entre dois chunks continua sendo costurado pela cauda", () => {
    const pattern = new RegExp(DECLARED);
    const first = feedTurnEndChunk("", "…ruído… Worked fo", pattern);
    expect(first.matched).toBe(false);
    expect(feedTurnEndChunk(first.tail, "r 12s\n", pattern).matched).toBe(true);
  });

  it("a cauda encolhe para TURN_END_BUFFER_MAX quando não casa, e casa depois disso", () => {
    const pattern = new RegExp(DECLARED);
    const fed = feedTurnEndChunk("", "y".repeat(5000), pattern);
    expect(fed.matched).toBe(false);
    expect(fed.tail.length).toBe(TURN_END_BUFFER_MAX);
    // A cauda preservada ainda costura o próximo pedaço do marcador.
    expect(feedTurnEndChunk(fed.tail, "… Worked for 2s", pattern).matched).toBe(true);
  });

  it("um marcador já consumido não re-dispara no turno seguinte", () => {
    const pattern = new RegExp(DECLARED);
    const first = feedTurnEndChunk("", "✻ Worked for 3s", pattern);
    expect(first.matched).toBe(true);
    expect(first.tail).toBe("");
    expect(feedTurnEndChunk(first.tail, "saída normal do próximo turno", pattern).matched).toBe(false);
  });
});

describe("(B) sem turn_complete a barra NUNCA apaga — a origem do 'running eterno'", () => {
  it("antes do sinal, todo byte religa e re-arma; depois do sinal reconhecido, não", () => {
    const declaresScreenSignal = true; // o provider declara; o marcador não casou
    let state = initialTerminalActivity();
    for (let i = 0; i < 50; i++) {
      const d = decideTerminalActivity(state, "data", declaresScreenSignal);
      state = d.next;
      expect(d.armIdleMs).not.toBeNull(); // relógio re-armado a cada repintura
    }
    expect(state.isActive).toBe(true);
    expect(state.signalProven).toBe(false);

    state = decideTerminalActivity(state, "turn_complete", declaresScreenSignal).next;
    expect(state.isActive).toBe(false);
    expect(state.signalProven).toBe(true);
    const after = decideTerminalActivity(state, "data", declaresScreenSignal);
    expect(after.next.isActive).toBe(false);
    expect(after.armIdleMs).toBeNull();
  });
});
