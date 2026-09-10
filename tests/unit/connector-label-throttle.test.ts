import { describe, it, expect } from "vitest";
import { decideConnectorLabelSchedule, type ConnectorLabelScheduleInput } from "../../src/renderer/src/connector-label-throttle";

// Review adversarial RODADA 5 (2026-09-09) — the reviewer's real point:
// "sem jsdom não dá" was being used as a blanket excuse for not testing
// the connector-label throttle's timing/transition logic at all. The
// actual bug that round (a board switch's `await loadBoard(next)` window
// stamping a throttle snapshot with the NEW board's id while
// `connectorsRef` still held the OLD board's connectors) is a pure
// function of state — no React, no DOM, no timers needed to express it.
// `decideConnectorLabelSchedule` is that pure function, extracted out of
// App.tsx's `scheduleConnectorLabelUpdate` specifically so this file can
// exist. These tests exercise the exact window the bug lived in, not
// just the easy cases.

const baseInput: ConnectorLabelScheduleInput = {
  boardTransitionInFlight: false,
  connectorExists: true,
  currentLabel: "label antiga",
  nextLabel: "label nova",
  now: 10_000,
  lastWriteAt: 0,
  hasPendingTimer: false,
  throttleWindowMs: 2_500,
};

describe("decideConnectorLabelSchedule", () => {
  it("board-transition em andamento => ignore, MESMO com um conector real e um label genuinamente novo", () => {
    // Este é o caso exato do achado real: connectorExists=true,
    // currentLabel !== nextLabel (mudança de verdade), throttle window já
    // elapsed o suficiente pra escrever na hora — tudo diz "escreva", só
    // que estamos na janela do await loadBoard(next). A transição vence
    // TUDO isso.
    const decision = decideConnectorLabelSchedule({
      ...baseInput,
      boardTransitionInFlight: true,
      connectorExists: true,
      currentLabel: "antiga",
      nextLabel: "nova",
      lastWriteAt: 0,
      now: 999_999,
    });
    expect(decision).toEqual({ action: "ignore", reason: "board-transition" });
  });

  it("board-transition em andamento vence mesmo quando o conector já não existe mais (checagem de transição é a PRIMEIRA)", () => {
    const decision = decideConnectorLabelSchedule({
      ...baseInput,
      boardTransitionInFlight: true,
      connectorExists: false,
    });
    expect(decision).toEqual({ action: "ignore", reason: "board-transition" });
  });

  it("conector sumiu (connectorExists: false) => ignore, fora de transição", () => {
    const decision = decideConnectorLabelSchedule({ ...baseInput, connectorExists: false });
    expect(decision).toEqual({ action: "ignore", reason: "connector-gone" });
  });

  it("label igual ao atual => ignore (nada mudou de verdade)", () => {
    const decision = decideConnectorLabelSchedule({ ...baseInput, currentLabel: "mesma coisa", nextLabel: "mesma coisa" });
    expect(decision).toEqual({ action: "ignore", reason: "same-label" });
  });

  it("janela do throttle já estourou e sem timer pendente => flush-now", () => {
    const decision = decideConnectorLabelSchedule({ ...baseInput, now: 10_000, lastWriteAt: 0, throttleWindowMs: 2_500, hasPendingTimer: false });
    expect(decision).toEqual({ action: "flush-now" });
  });

  it("dentro da janela do throttle => queue, com o tempo restante certo", () => {
    const decision = decideConnectorLabelSchedule({ ...baseInput, now: 1_000, lastWriteAt: 0, throttleWindowMs: 2_500, hasPendingTimer: false });
    expect(decision).toEqual({ action: "queue", waitMs: 1_500 });
  });

  it("janela estourou MAS já existe um timer pendente => queue (não dispara um 2º flush em paralelo)", () => {
    const decision = decideConnectorLabelSchedule({ ...baseInput, now: 10_000, lastWriteAt: 0, throttleWindowMs: 2_500, hasPendingTimer: true });
    expect(decision.action).toBe("queue");
  });

  it("waitMs nunca fica negativo quando a janela já estourou de sobra mas ainda há timer pendente", () => {
    // elapsed (10_000) É maior que throttleWindowMs (2_500) — sem
    // `hasPendingTimer`, isso seria flush-now; com um timer já pendente,
    // vira queue, e o cálculo cru (throttleWindowMs - elapsed) daria
    // -7_500 se não fosse pelo `Math.max(..., 0)`.
    const decision = decideConnectorLabelSchedule({ ...baseInput, now: 10_000, lastWriteAt: 0, throttleWindowMs: 2_500, hasPendingTimer: true });
    expect(decision).toEqual({ action: "queue", waitMs: 0 });
  });
});
