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
 * task dec5e889 — a FASE vem do MAIN no payload do board (`buildTaskBoard`
 * carrega `phase`, decidido por `deriveTaskPhase`). O renderer só LÊ: as duas
 * aproximações antigas (`hasReservedCard` fixo em false, `report !== null`
 * como "reportou desde a entrega") foram REMOVIDAS. Sem `phase` no payload, o
 * default é o "nenhum sinal" do próprio deriveTaskPhase (`ready`), nunca uma
 * segunda regra a partir de fatos parciais.
 */

const item = (over: BoardPhaseInput = {}): BoardPhaseInput => ({ ...over });

describe("deriveTaskPhaseForBoardItem — lê a phase do payload", () => {
  it("devolve exatamente a phase que veio do main", () => {
    for (const phase of ["waiting_deps", "ready", "reserved", "running", "awaiting_review", "changes_requested", "done", "failed"] as const) {
      expect(deriveTaskPhaseForBoardItem(item({ phase }))).toBe(phase);
    }
  });

  it("sem phase no payload → 'ready' (o valor de nenhum sinal do próprio deriveTaskPhase)", () => {
    expect(deriveTaskPhaseForBoardItem(item())).toBe("ready");
    expect(deriveTaskPhaseForBoardItem(item({ phase: null }))).toBe("ready");
  });

  it("NÃO deriva mais de fatos parciais — um item com cardAlive/report não inventa running/awaiting_review", () => {
    // An object with the old facts but NO `phase` falls back to "ready" — the
    // proof that deriving from partial facts was removed.
    const withOldFacts = {
      cardAlive: true,
      report: { verdict: "aprovado" },
      status: "pending",
      deps: [],
      depStatuses: {},
      verdicts: [],
    } as unknown as BoardPhaseInput;
    expect(deriveTaskPhaseForBoardItem(withOldFacts)).toBe("ready");
  });
});

describe("filtro rápido 'aguardando revisão'", () => {
  const tasks: BoardPhaseInput[] = [
    { phase: "awaiting_review" },
    { phase: "running" },
    { phase: "done" },
    { phase: "awaiting_review" },
    { phase: "reserved" },
  ];

  it("conta só as aguardando revisão", () => {
    expect(countAwaitingReview(tasks)).toBe(2);
  });

  it("inativo devolve a lista inteira; ativo filtra", () => {
    expect(filterTasksByAwaitingReview(tasks, false)).toHaveLength(5);
    expect(filterTasksByAwaitingReview(tasks, true)).toHaveLength(2);
  });
});

describe("chip (rótulo + tom) e estado da gaveta", () => {
  it("toda fase tem chave i18n e tom", () => {
    for (const phase of Object.keys(PHASE_LABEL_KEY) as (keyof typeof PHASE_LABEL_KEY)[]) {
      expect(PHASE_LABEL_KEY[phase]).toMatch(/^task\.phase\./);
      expect(PHASE_TONE[phase]).toBeTruthy();
    }
  });

  it("reservationStateFromPhase mapeia a fase para o estado da gaveta", () => {
    expect(reservationStateFromPhase("running")).toBe("running");
    expect(reservationStateFromPhase("awaiting_review")).toBe("review");
    expect(reservationStateFromPhase("changes_requested")).toBe("review");
    expect(reservationStateFromPhase("waiting_deps")).toBe("waiting-deps");
    expect(reservationStateFromPhase("reserved")).toBe("ready");
    expect(reservationStateFromPhase(null)).toBe("ready");
  });
});
