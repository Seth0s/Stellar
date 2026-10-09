/**
 * FASE DERIVADA de uma task (task 6266d3e7, 2026-10-04) — decisão PURA.
 *
 * PROBLEMA MEDIDO (board 64): uma task rodando e uma esperando a revisão do
 * orquestrador apareciam AMBAS como `pending` — não dava para ver o que estava
 * parado esperando por alguém. A `phase` é DERIVADA (não é o status
 * autoritativo e NÃO muda a regra de status humano): é a leitura de "em que
 * ponto do fluxo esta task está" a partir de fatos que o resto do sistema já
 * conhece (deps, vínculo de card reservado/ativo, report do implementer depois
 * da última entrega, veredito de reviewer).
 *
 * Sem I/O, sem store: o chamador monta os FATOS e esta função decide.
 */

import { isDependencySettled } from "../task-status-derive";
import { declaredTaskIdFromReportBody } from "./report-task-link-decision";
import { reportConcludesTask } from "./report-estado-decision";

export type TaskPhase =
  | "waiting_deps"
  | "ready"
  | "reserved"
  | "running"
  | "awaiting_review"
  | "changes_requested"
  | "done"
  | "failed"
  | "superseded";

/** Fatos que o chamador já tem sobre UMA task. */
export type TaskPhaseFacts = {
  /** `tasks.status` — o autoritativo. Só `done`/`failed` são terminais aqui. */
  status: string;
  deps: readonly { status: string | null }[];
  /** Existe implementer ATIVO (vínculo não-reservado, card vivo). */
  hasActiveImplementer: boolean;
  /** Existe vínculo RESERVADO (gaveta) para esta task. */
  hasReservedCard: boolean;
  /** Report do IMPLEMENTER chegou depois da última concessão de trabalho. */
  implementerReportedSinceLastDelivery: boolean;
  /** Um reviewer deu veredito `ok:false` depois do último report. */
  reviewerChangesRequested: boolean;
};

/**
 * Precedência (declarada, não inferida):
 *   done/failed (terminal) > waiting_deps > changes_requested > awaiting_review
 *   > running > reserved > ready.
 *
 * `waiting_deps` vem antes de tudo que é "de execução" porque deps pendentes é
 * o bloqueio REAL: sem isso a task não começa, tenha card ou não. `done/failed`
 * vem primeiro porque são terminais — a fase de uma task concluída é a
 * conclusão, nunca "aguardando revisão".
 */
export function deriveTaskPhase(facts: TaskPhaseFacts): TaskPhase {
  if (facts.status === "done") return "done";
  if (facts.status === "failed") return "failed";
  // `superseded` is a terminal of its own: a task swapped for another one is
  // never "failed". It comes with the other terminals.
  if (facts.status === "superseded") return "superseded";
  // A dep that is `done` OR `superseded` does NOT block: the second one was
  // replaced, and the engine only notifies the orchestrator to swap the edge —
  // it never leaves the dependent stuck forever (see `isDependencySettled`).
  if (facts.deps.some((d) => !isDependencySettled(d.status))) return "waiting_deps";
  if (facts.reviewerChangesRequested) return "changes_requested";
  // O report do implementer é o gatilho da revisão — vale mesmo que o card já
  // tenha saído (o veredito pendente continua sendo do orquestrador).
  if (facts.implementerReportedSinceLastDelivery) return "awaiting_review";
  if (facts.hasActiveImplementer) return "running";
  if (facts.hasReservedCard) return "reserved";
  return "ready";
}

/**
 * Raw facts a board projection already holds for one task, before they are
 * shaped into `TaskPhaseFacts`. The board payload reads them from the store
 * and the registry; keeping the shaping here means the same rule decides the
 * phase everywhere, and the projection cannot drift into a second rule.
 */
export type BoardTaskPhaseFactsInput = {
  /** `tasks.status`. */
  status: string;
  /** One entry per dependency: its status, or null when unknown. */
  depStatuses: readonly (string | null)[];
  /** Live implementer links: null reservation_state = active, "reserved" = held. */
  liveImplementers: readonly { reservation_state: string | null }[];
  /**
   * True only when `implementerReportedFinalSinceDelivery` says this task
   * has an ok:true + estado final report after the last delivery. The
   * caller applies attribution; this shape does not see the card's latest row.
   */
  implementerReportedSinceLastDelivery: boolean;
  /** A reviewer asked for changes after the latest report of this task. */
  reviewerChangesRequested: boolean;
};

export function boardTaskPhaseFacts(input: BoardTaskPhaseFactsInput): TaskPhaseFacts {
  return {
    status: input.status,
    deps: input.depStatuses.map((status) => ({ status })),
    hasActiveImplementer: input.liveImplementers.some((l) => l.reservation_state == null),
    hasReservedCard: input.liveImplementers.some((l) => l.reservation_state === "reserved"),
    implementerReportedSinceLastDelivery: input.implementerReportedSinceLastDelivery,
    reviewerChangesRequested: input.reviewerChangesRequested,
  };
}

/** Convenience wrapper for callers that only need the phase. */
export function deriveBoardTaskPhase(input: BoardTaskPhaseFactsInput): TaskPhase {
  return deriveTaskPhase(boardTaskPhaseFacts(input));
}

/** One stored report of the implementer card, body already decoded. */
export type PhaseReportRow = {
  body: unknown;
  at: number;
};

/**
 * Whether the implementer has delivered THIS task since the last work grant.
 *
 * The card is a slot: its newest row may belong to another task, and a
 * checkpoint (`estado` omitted or `parcial`) is not a delivery. Only the
 * latest row whose declared task id is `taskId` and whose time is at or
 * after `lastDeliveryAt` counts, and only when that row is ok:true with
 * estado final. `lastDeliveryAt === null` means the caller has no clock,
 * so every attributed row is in the window.
 */
export function implementerReportedFinalSinceDelivery(input: {
  taskId: string;
  reports: readonly PhaseReportRow[];
  lastDeliveryAt: number | null;
}): boolean {
  const latest = latestAttributedInWindow(input.taskId, input.reports, input.lastDeliveryAt);
  return latest !== null && reportConcludesTask(latest.body);
}

/** Time of the newest report declared for this task, ignoring the window.
 *  Reviewer "changes requested" compares against this, not against another
 *  task's row on the same card. */
export function latestAttributedReportAt(
  taskId: string,
  reports: readonly PhaseReportRow[],
): number | null {
  let at: number | null = null;
  for (const row of reports) {
    if (declaredTaskIdFromReportBody(row.body) !== taskId) continue;
    if (at === null || row.at >= at) at = row.at;
  }
  return at;
}

function latestAttributedInWindow(
  taskId: string,
  reports: readonly PhaseReportRow[],
  lastDeliveryAt: number | null,
): PhaseReportRow | null {
  let latest: PhaseReportRow | null = null;
  for (const row of reports) {
    if (declaredTaskIdFromReportBody(row.body) !== taskId) continue;
    if (lastDeliveryAt !== null && row.at < lastDeliveryAt) continue;
    if (!latest || row.at >= latest.at) latest = row;
  }
  return latest;
}
