import { describe, expect, it } from "vitest";
import {
  deriveTaskPhase,
  implementerReportedFinalSinceDelivery,
  type TaskPhase,
  type TaskPhaseFacts,
} from "../../src/main/task-phase-decision";

/**
 * Task 6266d3e7 — a fase DERIVADA. Teste de TABELA (o aceite pede "decisão pura
 * + testes de tabela"): cada linha é um conjunto de fatos e a fase esperada.
 */

type Row = [string, Partial<TaskPhaseFacts>, TaskPhase];

const done = { status: "done" } as const;
const pending = { status: "pending" } as const;

const rows: Row[] = [
  ["task done → done (terminal vence tudo)", { status: "done", deps: [pending], hasActiveImplementer: true }, "done"],
  ["task failed → failed (terminal vence tudo)", { status: "failed", deps: [pending] }, "failed"],
  ["dep pendente → waiting_deps (mesmo com card ativo)", { status: "pending", deps: [pending], hasActiveImplementer: true }, "waiting_deps"],
  ["dep pendente → waiting_deps (mesmo com report)", { status: "pending", deps: [{ status: "running" }], implementerReportedSinceLastDelivery: true }, "waiting_deps"],
  ["deps ok, sem card → ready", { status: "pending", deps: [done] }, "ready"],
  ["sem deps e sem card → ready", { status: "pending" }, "ready"],
  ["card RESERVADO, sem ativo → reserved", { status: "pending", deps: [done], hasReservedCard: true }, "reserved"],
  ["implementer ativo, sem report depois da entrega → running", { status: "pending", hasActiveImplementer: true }, "running"],
  ["implementer reportou depois da última entrega → awaiting_review", { status: "pending", hasActiveImplementer: true, implementerReportedSinceLastDelivery: true }, "awaiting_review"],
  ["report com o card já saído → awaiting_review (a revisão continua pendente)", { status: "pending", implementerReportedSinceLastDelivery: true }, "awaiting_review"],
  ["reviewer pediu mudanças depois do último report → changes_requested", { status: "pending", implementerReportedSinceLastDelivery: true, reviewerChangesRequested: true }, "changes_requested"],
  ["changes_requested vence running", { status: "pending", hasActiveImplementer: true, reviewerChangesRequested: true }, "changes_requested"],
];

describe("deriveTaskPhase — tabela", () => {
  it.each(rows)("%s", (_name, facts, expected) => {
    expect(deriveTaskPhase({ deps: [], hasActiveImplementer: false, hasReservedCard: false, implementerReportedSinceLastDelivery: false, reviewerChangesRequested: false, status: "pending", ...facts })).toBe(expected);
  });

  it("todo valor de fase é um dos oito declarados", () => {
    const values: TaskPhase[] = [];
    for (const [, facts] of rows) {
      values.push(deriveTaskPhase({ deps: [], hasActiveImplementer: false, hasReservedCard: false, implementerReportedSinceLastDelivery: false, reviewerChangesRequested: false, status: "pending", ...facts }));
    }
    const allowed = new Set(["waiting_deps", "ready", "reserved", "running", "awaiting_review", "changes_requested", "done", "failed"]);
    for (const v of values) expect(allowed.has(v)).toBe(true);
  });

  it("reserved NÃO vence running/awaiting_review (precedência declarada)", () => {
    expect(deriveTaskPhase({ status: "pending", deps: [], hasReservedCard: true, hasActiveImplementer: true, implementerReportedSinceLastDelivery: false, reviewerChangesRequested: false })).toBe("running");
    expect(deriveTaskPhase({ status: "pending", deps: [], hasReservedCard: true, hasActiveImplementer: false, implementerReportedSinceLastDelivery: true, reviewerChangesRequested: false })).toBe("awaiting_review");
  });
});

const runningFacts = {
  status: "pending",
  deps: [],
  hasActiveImplementer: true,
  hasReservedCard: false,
  reviewerChangesRequested: false,
} as const;

function phaseFromReports(
  taskId: string,
  reports: { body: unknown; at: number }[],
  lastDeliveryAt: number | null,
): TaskPhase {
  const delivered = implementerReportedFinalSinceDelivery({ taskId, reports, lastDeliveryAt });
  return deriveTaskPhase({
    ...runningFacts,
    implementerReportedSinceLastDelivery: delivered,
  });
}

describe("implementerReportedFinalSinceDelivery — atribuição + estado", () => {
  const finalA = { body: { ok: true, taskId: "A", estado: "final" }, at: 5_000 };
  const finalB = { body: { ok: true, taskId: "B", estado: "final" }, at: 6_000 };

  it("(a) card reusado: report final da task A, vínculo na B → B fica running", () => {
    expect(phaseFromReports("B", [finalA], 4_000)).toBe("running");
    expect(implementerReportedFinalSinceDelivery({ taskId: "B", reports: [finalA], lastDeliveryAt: 4_000 })).toBe(false);
  });

  it("(b) report parcial da própria task → running", () => {
    const parcial = { body: { ok: true, taskId: "B", estado: "parcial" }, at: 6_000 };
    expect(phaseFromReports("B", [parcial], 4_000)).toBe("running");
    expect(phaseFromReports("B", [{ body: { ok: true, taskId: "B" }, at: 6_000 }], 4_000)).toBe("running");
  });

  it("(c) report final da própria task → awaiting_review", () => {
    expect(phaseFromReports("B", [finalB], 4_000)).toBe("awaiting_review");
  });

  it("(d) report final antigo, anterior ao novo delivery (rodada 2) → running", () => {
    expect(phaseFromReports("B", [finalB], 7_000)).toBe("running");
  });

  it("o último da rodada decide: final seguido de parcial volta a running", () => {
    expect(
      phaseFromReports(
        "B",
        [finalB, { body: { ok: true, taskId: "B", estado: "parcial" }, at: 8_000 }],
        4_000,
      ),
    ).toBe("running");
  });

  it("`task` declarado vence `taskId` conflitante (mesma regra de atribuição)", () => {
    const conflict = { body: { ok: true, taskId: "A", task: "B", estado: "final" }, at: 6_000 };
    expect(phaseFromReports("B", [conflict], 4_000)).toBe("awaiting_review");
    expect(phaseFromReports("A", [conflict], 4_000)).toBe("running");
  });
});
