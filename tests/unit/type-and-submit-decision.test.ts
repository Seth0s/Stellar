import { describe, it, expect } from "vitest";
import {
  decideWriteReadiness,
  decideSubmitCheck,
  decideDeliveryGate,
  HUMAN_INPUT_GATE_MAX_AGE_MS,
  WRITE_READY_QUIET_MS,
  WRITE_READY_MAX_WAIT_MS,
  type WriteReadinessInput,
  type SubmitCheckInput,
} from "../../src/main/type-and-submit-decision";

// DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
// caixa sem submeter" (relatado ao vivo 2x, 2026-09-11, com `codex`) — 2
// causas raiz que se somavam: (1) nada esperava a TUI do CLI terminar de
// subir antes de digitar; (2) a confirmação (`looksUnsent`, booleana)
// tratava "prefixo ausente da tela" como "enviado", sem distinguir de
// "tela ainda não desenhou nada". Este arquivo testa as 2 decisões puras
// que fecham cada achado.

describe("decideWriteReadiness", () => {
  const base: WriteReadinessInput = {
    hasReceivedData: false,
    msSinceLastActivity: 0,
    msSinceSpawn: 0,
  };

  it("nunca recebeu dado nenhum, spawn recente => wait (TUI ainda pode estar subindo)", () => {
    expect(decideWriteReadiness({ ...base, hasReceivedData: false, msSinceSpawn: 500 })).toEqual({ action: "wait" });
  });

  it("recebeu dado mas ainda dentro da janela de quiescência => wait (TUI pode estar no meio de um redraw)", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: WRITE_READY_QUIET_MS - 1, msSinceSpawn: 500 }),
    ).toEqual({ action: "wait" });
  });

  it("recebeu dado e passou da janela de quiescência => proceed/quiet (caso comum: TUI subiu e se aquietou)", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: WRITE_READY_QUIET_MS, msSinceSpawn: 500 }),
    ).toEqual({ action: "proceed", reason: "quiet" });
  });

  it("card vivo há muito tempo (msSinceSpawn enorme) e quieto há muito tempo => proceed/quiet sem esperar nada — caso comum de send_to_card/report/idle/task-moved", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: 3_600_000, msSinceSpawn: 3_600_000 }),
    ).toEqual({ action: "proceed", reason: "quiet" });
  });

  it("nunca ficou quieto (processo continua produzindo saída, ex. logs) mas já passou do teto de segurança => proceed/timeout, não trava pra sempre", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: 1, msSinceSpawn: WRITE_READY_MAX_WAIT_MS }),
    ).toEqual({ action: "proceed", reason: "timeout" });
  });

  it("card vivo há muito tempo mas SEMPRE ativo (nunca quieto) => proceed/timeout imediato, sem custo perceptível", () => {
    // Cobre exatamente a preocupação da tarefa: um card já pronto há muito
    // tempo (bash despejando log continuamente, por ex.) não pode ficar
    // preso esperando quiescência que nunca vem.
    expect(
      decideWriteReadiness({ hasReceivedData: true, msSinceLastActivity: 1, msSinceSpawn: 3_600_000 }),
    ).toEqual({ action: "proceed", reason: "timeout" });
  });

  it("nunca recebeu dado nenhum e já passou do teto de segurança => proceed/timeout (desiste de esperar, tenta mesmo assim)", () => {
    expect(
      decideWriteReadiness({ hasReceivedData: false, msSinceLastActivity: WRITE_READY_MAX_WAIT_MS, msSinceSpawn: WRITE_READY_MAX_WAIT_MS }),
    ).toEqual({ action: "proceed", reason: "timeout" });
  });
});

describe("decideSubmitCheck", () => {
  const base: SubmitCheckInput = {
    screenText: "",
    sentPrefix: "consertar o roteamento",
    hasNewActivitySinceWrite: true,
  };

  it("prefixo ainda visível na tela => unsent, não importa a atividade", () => {
    expect(decideSubmitCheck({ ...base, screenText: "> consertar o roteamento do push", hasNewActivitySinceWrite: true })).toBe("unsent");
    expect(decideSubmitCheck({ ...base, screenText: "> consertar o roteamento do push", hasNewActivitySinceWrite: false })).toBe("unsent");
  });

  it("placeholder de paste colapsado => unsent", () => {
    expect(decideSubmitCheck({ ...base, screenText: "[Pasted text #1 +40 lines]", hasNewActivitySinceWrite: true })).toBe("unsent");
  });

  it("achado 2 — prefixo ausente MAS sem nenhuma atividade nova desde o write => unknown, nunca 'sent' (a causa raiz do bug: tela de boot ainda não desenhou nada)", () => {
    expect(decideSubmitCheck({ ...base, screenText: "", hasNewActivitySinceWrite: false })).toBe("unknown");
    expect(decideSubmitCheck({ ...base, screenText: "Loading codex...", hasNewActivitySinceWrite: false })).toBe("unknown");
  });

  it("prefixo ausente E o card mostrou atividade nova desde o write => sent (caso comum, providers rápidos)", () => {
    expect(decideSubmitCheck({ ...base, screenText: "> Thinking...", hasNewActivitySinceWrite: true })).toBe("sent");
  });

  it("prefixo curto demais pra confiar (<8 chars) nunca conta como unsent, mesmo presente literalmente na tela", () => {
    expect(decideSubmitCheck({ screenText: "oi", sentPrefix: "oi", hasNewActivitySinceWrite: true })).toBe("sent");
  });
});

describe("decideDeliveryGate", () => {
  it("linha vazia deixa a entrega passar imediatamente", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: false, pendingHumanInputStartedAtMs: null, nowMs: 10_000 }),
    ).toEqual({ action: "proceed", reason: "empty" });
  });

  it("linha humana recente bloqueia a entrega", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: true, pendingHumanInputStartedAtMs: 10_000, nowMs: 10_000 + HUMAN_INPUT_GATE_MAX_AGE_MS - 1 }),
    ).toEqual({ action: "wait", reason: "human-input" });
  });

  it("linha abandonada no teto deixa a entrega prosseguir sem ser descartada", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: true, pendingHumanInputStartedAtMs: 10_000, nowMs: 10_000 + HUMAN_INPUT_GATE_MAX_AGE_MS }),
    ).toEqual({ action: "proceed", reason: "expired" });
  });

  it("estado antigo sem timestamp não bloqueia a fila para sempre", () => {
    expect(
      decideDeliveryGate({ hasPendingHumanInput: true, pendingHumanInputStartedAtMs: null, nowMs: 10_000 }),
    ).toEqual({ action: "proceed", reason: "unknown-age" });
  });
});
