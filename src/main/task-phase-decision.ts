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

export type TaskPhase =
  | "waiting_deps"
  | "ready"
  | "reserved"
  | "running"
  | "awaiting_review"
  | "changes_requested"
  | "done"
  | "failed";

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
  if (facts.deps.some((d) => d.status !== "done")) return "waiting_deps";
  if (facts.reviewerChangesRequested) return "changes_requested";
  // O report do implementer é o gatilho da revisão — vale mesmo que o card já
  // tenha saído (o veredito pendente continua sendo do orquestrador).
  if (facts.implementerReportedSinceLastDelivery) return "awaiting_review";
  if (facts.hasActiveImplementer) return "running";
  if (facts.hasReservedCard) return "reserved";
  return "ready";
}
