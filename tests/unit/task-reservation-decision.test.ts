import { describe, expect, it } from "vitest";
import {
  decideCardBusyForReservation,
  decideLinkMode,
  decideReservationDelivery,
  decideReservationItemState,
  firstReadyReservation,
  pendingDeps,
  reorderReservations,
  RESERVATION_STUCK_MS,
  type ReservationItem,
} from "../../src/main/task-reservation-decision";

/**
 * Task 377a6029 — reserva de tasks por card. Decisões puras: modo default do
 * link (fecha o defeito E7/E9b), seleção da próxima reserva a entregar (só com
 * o card livre), estado exibido na gaveta, e reordenação como permutação.
 */

const dep = (id: string, status: string | null) => ({ id, status });

describe("decideLinkMode — o default pelas deps (E7/E9b)", () => {
  it("sem deps ⇒ entrega agora", () => {
    expect(decideLinkMode({ deps: [] })).toBe("deliver");
  });

  it("todas as deps done ⇒ entrega agora", () => {
    expect(decideLinkMode({ deps: [dep("a", "done"), dep("b", "done")] })).toBe("deliver");
  });

  it("QUALQUER dep pendente ⇒ RESERVA (não entrega antes das deps fecharem)", () => {
    expect(decideLinkMode({ deps: [dep("a", "done"), dep("b", "running")] })).toBe("reserve");
    expect(decideLinkMode({ deps: [dep("a", "pending")] })).toBe("reserve");
  });

  it("mode explícito sempre vence as deps", () => {
    expect(decideLinkMode({ mode: "reserve", deps: [dep("a", "done")] })).toBe("reserve");
    expect(decideLinkMode({ mode: "deliver", deps: [dep("a", "pending")] })).toBe("deliver");
  });
});

describe("pendingDeps", () => {
  it("lista só o que não está done, na ordem declarada", () => {
    expect(pendingDeps([dep("a", "done"), dep("b", "pending"), dep("c", null)]).map((d) => d.id)).toEqual(["b", "c"]);
  });
});

describe("decideReservationDelivery — só entrega com o card LIVRE", () => {
  const item = (taskId: string, statuses: (string | null)[], state: "reserved" | "active" = "reserved"): ReservationItem => ({
    taskId,
    state,
    deps: statuses.map((s, i) => dep(`${taskId}-d${i}`, s)),
  });

  it("entrega a PRIMEIRA da fila cujas deps estão todas done", () => {
    const order = [item("t1", ["pending"]), item("t2", ["done"]), item("t3", ["done"])];
    expect(decideReservationDelivery({ order, cardBusy: false })).toEqual({ taskId: "t2" });
  });

  it("card ocupado ⇒ NÃO entrega (espera o próximo fim de turno, nunca interrompe)", () => {
    const order = [item("t1", ["done"])];
    expect(decideReservationDelivery({ order, cardBusy: true })).toEqual({ taskId: null, reason: "card-busy" });
  });

  it("item `active` não é reentregue", () => {
    const order = [item("t1", ["done"], "active"), item("t2", ["done"])];
    expect(decideReservationDelivery({ order, cardBusy: false })).toEqual({ taskId: "t2" });
  });

  it("nenhuma pronta ⇒ none-ready", () => {
    const order = [item("t1", ["running"])];
    expect(decideReservationDelivery({ order, cardBusy: false })).toEqual({ taskId: null, reason: "none-ready" });
  });
});

describe("decideReservationItemState — os estados da gaveta", () => {
  const base = { isDelivering: false, cardHasActiveTask: false, awaitingReview: false };
  it("deps pendentes vencem tudo (esperando deps)", () => {
    expect(decideReservationItemState({ ...base, deps: [dep("a", "pending")], isDelivering: true, cardHasActiveTask: true })).toBe("waiting-deps");
  });
  it("sem deps pendentes: entregando > rodando > aguardando revisão > pronta", () => {
    expect(decideReservationItemState({ ...base, deps: [], isDelivering: true, cardHasActiveTask: true, awaitingReview: true })).toBe("delivering");
    expect(decideReservationItemState({ ...base, deps: [], cardHasActiveTask: true, awaitingReview: true })).toBe("running");
    expect(decideReservationItemState({ ...base, deps: [], awaitingReview: true })).toBe("review");
    expect(decideReservationItemState({ ...base, deps: [] })).toBe("ready");
  });
});

describe("reorderReservations — permutação exata, nunca escrita destrutiva", () => {
  it("reordena quando é permutação", () => {
    expect(reorderReservations(["a", "b", "c"], ["c", "a", "b"])).toEqual({ ok: true, order: ["c", "a", "b"] });
  });
  it("recusa tamanho diferente", () => {
    expect(reorderReservations(["a", "b"], ["a"]).ok).toBe(false);
  });
  it("recusa id de fora e id duplicado", () => {
    expect(reorderReservations(["a", "b"], ["a", "z"]).ok).toBe(false);
    expect(reorderReservations(["a", "b"], ["a", "a"]).ok).toBe(false);
  });
});

/**
 * The reservation engine runs on `onTaskDone` only, so a dependency that closes
 * while the card is mid-turn is not delivered then. The end-of-turn trigger is
 * what re-evaluates it; this rule (free = a declared turn end with nothing
 * after) stays as it was — `workGrantedAt` is set at spawn.
 */
describe("decideCardBusyForReservation — o sinal é o FIM DE TURNO", () => {
  it("implementer ACTIVE sempre é ocupado", () => {
    expect(decideCardBusyForReservation({ hasActiveImplementer: true, turnEndedAt: 9_000, workGrantedAt: 1_000 })).toBe(true);
  });

  it("sem fim de turno DECLARADO → ocupado (não se entrega no meio do turno)", () => {
    expect(decideCardBusyForReservation({ hasActiveImplementer: false, turnEndedAt: null, workGrantedAt: 1_000 })).toBe(true);
  });

  it("turno terminou e nada foi concedido depois → LIVRE", () => {
    expect(decideCardBusyForReservation({ hasActiveImplementer: false, turnEndedAt: 2_000, workGrantedAt: 1_000 })).toBe(false);
  });

  it("trabalho concedido DEPOIS do fim do turno → ocupado (turno novo em andamento)", () => {
    expect(decideCardBusyForReservation({ hasActiveImplementer: false, turnEndedAt: 2_000, workGrantedAt: 3_000 })).toBe(true);
  });
});

describe("firstReadyReservation — base do watchdog", () => {
  const item = (taskId: string, statuses: (string | null)[], state: "reserved" | "active" = "reserved"): ReservationItem => ({
    taskId,
    state,
    deps: statuses.map((s, i) => ({ id: `${taskId}-d${i}`, status: s })),
  });

  it("devolve a primeira reserva com TODAS as deps done; ignora a que tem dep pendente", () => {
    expect(firstReadyReservation([item("t1", ["pending"]), item("t2", ["done"])])?.taskId).toBe("t2");
    expect(firstReadyReservation([item("t1", ["pending"])])).toBeNull();
    expect(firstReadyReservation([])).toBeNull();
  });

  it("RESERVATION_STUCK_MS é positivo (o watchdog precisa de um N)", () => {
    expect(RESERVATION_STUCK_MS).toBeGreaterThan(0);
  });
});
