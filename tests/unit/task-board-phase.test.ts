import { describe, expect, it } from "vitest";
import {
  countAwaitingReview,
  deriveTaskPhaseForBoardItem,
  filterTasksByAwaitingReview,
  PHASE_LABEL_KEY,
  PHASE_TONE,
  reservationStateFromPhase,
  type BoardPhaseInput,
} from "../../src/renderer/src/task-board-model";

/**
 * Task 6266d3e7 — o chip de fase da Fila e o filtro "aguardando revisão". A
 * derivação monta os fatos do item do board e delega à MESMA regra do main
 * (`deriveTaskPhase`); aqui fixamos a montagem e o filtro.
 */

function item(over: Partial<BoardPhaseInput> = {}): BoardPhaseInput {
  return { status: "pending", deps: [], depStatuses: {}, cardAlive: false, report: null, verdicts: [], ...over };
}

describe("deriveTaskPhaseForBoardItem", () => {
  it("done/failed são terminais", () => {
    expect(deriveTaskPhaseForBoardItem(item({ status: "done" }))).toBe("done");
    expect(deriveTaskPhaseForBoardItem(item({ status: "failed" }))).toBe("failed");
  });

  it("dep pendente vence tudo (bloqueio real)", () => {
    expect(deriveTaskPhaseForBoardItem(item({ deps: ["d1"], depStatuses: { d1: "running" }, cardAlive: true }))).toBe("waiting_deps");
  });

  it("report do implementer → awaiting_review (mesmo com card vivo)", () => {
    expect(deriveTaskPhaseForBoardItem(item({ cardAlive: true, report: { verdict: "aprovado" } }))).toBe("awaiting_review");
  });

  it("veredito reprovado → changes_requested", () => {
    expect(deriveTaskPhaseForBoardItem(item({ cardAlive: true, verdicts: [{ verdict: "reprovado" }] }))).toBe("changes_requested");
  });

  it("card vivo sem report → running; sem nada → ready", () => {
    expect(deriveTaskPhaseForBoardItem(item({ cardAlive: true }))).toBe("running");
    expect(deriveTaskPhaseForBoardItem(item())).toBe("ready");
  });
});

describe("chip (rótulo + tom)", () => {
  it("toda fase tem chave i18n e tom", () => {
    for (const phase of Object.keys(PHASE_LABEL_KEY) as (keyof typeof PHASE_LABEL_KEY)[]) {
      expect(PHASE_LABEL_KEY[phase]).toMatch(/^task\.phase\./);
      expect(PHASE_TONE[phase]).toBeTruthy();
    }
  });
});

describe("filtro rápido 'aguardando revisão'", () => {
  const tasks = [
    item({ status: "pending", report: { verdict: null } }), // awaiting_review
    item({ status: "pending", cardAlive: true }), // running
    item({ status: "done" }), // done
    item({ status: "pending", report: { verdict: null } }), // awaiting_review
  ];

  it("conta só as aguardando revisão", () => {
    expect(countAwaitingReview(tasks)).toBe(2);
  });

  it("inativo devolve a lista inteira; ativo filtra", () => {
    expect(filterTasksByAwaitingReview(tasks, false)).toHaveLength(4);
    expect(filterTasksByAwaitingReview(tasks, true)).toHaveLength(2);
  });
});

describe("reservationStateFromPhase", () => {
  it("rodando → running; aguardando revisão → review; deps → waiting-deps; resto → ready", () => {
    expect(reservationStateFromPhase("running")).toBe("running");
    expect(reservationStateFromPhase("awaiting_review")).toBe("review");
    expect(reservationStateFromPhase("changes_requested")).toBe("review");
    expect(reservationStateFromPhase("waiting_deps")).toBe("waiting-deps");
    expect(reservationStateFromPhase("reserved")).toBe("ready");
    expect(reservationStateFromPhase(null)).toBe("ready");
  });
});
