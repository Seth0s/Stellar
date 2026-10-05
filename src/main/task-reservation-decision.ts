/**
 * RESERVA DE TASKS POR CARD (task 377a6029, 2026-10-04) — decisão PURA.
 *
 * PROBLEMAS MEDIDOS no board 64:
 *  - `link_task_card` ENTREGAVA o contrato na hora: E7/E9b começaram antes das
 *    deps fecharem. Um card pode ter uma FILA de tasks RESERVADAS; reservar não
 *    entrega nada.
 *  - Quando as deps de uma reserva fecham, ninguém avisa o card: o orquestrador
 *    manda o "comece" à mão. A entrega tem de ser AUTOMÁTICA, e só quando o card
 *    estiver LIVRE (fim de turno medido + nenhuma task active).
 *  - E10 ganhou um SEGUNDO implementer por auto-dispatch mesmo já tendo um card.
 *
 * Este módulo só decide — sem I/O, sem store, sem PTY — para que a regra seja
 * testada sem subir o app. Mesmo padrão dos outros `*-decision.ts`.
 */

export type ReservationOrderMode = "reserve" | "deliver";

export type DepView = { id: string; status: string | null };

/**
 * O MODO DEFAULT do vínculo, decidido pelas DEPS — é isto que fecha o defeito
 * da E7/E9b. Um `mode` explícito sempre vence (é a escolha declarada de quem
 * chama); sem ele: sem deps ou TODAS done → `deliver`; qualquer dep pendente →
 * `reserve` (o contrato NÃO é entregue agora).
 */
export function decideLinkMode(input: {
  mode?: ReservationOrderMode | null;
  deps: readonly DepView[];
}): ReservationOrderMode {
  if (input.mode === "reserve" || input.mode === "deliver") return input.mode;
  if (input.deps.length === 0) return "deliver";
  return input.deps.every((d) => d.status === "done") ? "deliver" : "reserve";
}

/** Deps de um item que ainda não fecharam (na ordem declarada). */
export function pendingDeps(deps: readonly DepView[]): DepView[] {
  return deps.filter((d) => d.status !== "done");
}

export type ReservationItem = {
  taskId: string;
  /** Estado do vínculo: `reserved` (na fila) ou `active` (em execução). */
  state: "reserved" | "active";
  deps: readonly DepView[];
};

export type ReservationDeliveryDecision =
  | { taskId: string }
  | { taskId: null; reason: "card-busy" | "none-ready" };

/**
 * Qual reserva ENTREGAR agora. Regra do dono: a PRIMEIRA da fila cujas deps
 * estão todas done, e SÓ quando o card está LIVRE. Card ocupado → espera o
 * próximo fim de turno, nunca interrompe. `active` NÃO é entregue (já roda).
 */
export function decideReservationDelivery(input: {
  order: readonly ReservationItem[];
  cardBusy: boolean;
}): ReservationDeliveryDecision {
  if (input.cardBusy) return { taskId: null, reason: "card-busy" };
  for (const item of input.order) {
    if (item.state !== "reserved") continue;
    if (pendingDeps(item.deps).length > 0) continue;
    return { taskId: item.taskId };
  }
  return { taskId: null, reason: "none-ready" };
}

export type ReservationDisplayState = "waiting-deps" | "delivering" | "running" | "review" | "ready";

/**
 * O estado que a GAVETA mostra para um item. Ordem de precedência fixa:
 * deps pendentes vencem tudo (é o bloqueio real); depois o que está de fato
 * acontecendo (entregando/rodando); depois "aguardando revisão"; senão pronta.
 */
export function decideReservationItemState(input: {
  deps: readonly DepView[];
  isDelivering: boolean;
  cardHasActiveTask: boolean;
  awaitingReview: boolean;
}): ReservationDisplayState {
  if (pendingDeps(input.deps).length > 0) return "waiting-deps";
  if (input.isDelivering) return "delivering";
  if (input.cardHasActiveTask) return "running";
  if (input.awaitingReview) return "review";
  return "ready";
}

/**
 * Reordenação por arrasto. A lista pedida tem de ser uma PERMUTAÇÃO exata da
 * atual — reordenar não pode perder nem inventar reservas (o contrário seria
 * uma escrita destrutiva disfarçada de gesto de UI).
 */
export function reorderReservations(
  current: readonly string[],
  requested: readonly string[],
): { ok: true; order: string[] } | { ok: false; error: string } {
  if (requested.length !== current.length) {
    return { ok: false, error: `expected ${current.length} task(s), got ${requested.length}` };
  }
  const currentSet = new Set(current);
  const seen = new Set<string>();
  for (const id of requested) {
    if (!currentSet.has(id)) return { ok: false, error: `task "${id}" is not in this card's queue` };
    if (seen.has(id)) return { ok: false, error: `task "${id}" appears twice` };
    seen.add(id);
  }
  return { ok: true, order: [...requested] };
}

/**
 * Is the card free to receive a reservation? The free signal is a declared END
 * OF TURN: without `turnEndedAt` the card counts as busy. Byte activity is not
 * used on purpose — an idle TUI repaints and keeps its activity clock fresh.
 * A dependency that closes while the card is mid-turn is therefore not acted on
 * at that moment; the end-of-turn trigger in `message-bus.ts` re-evaluates it.
 */
export type ReservationCardBusyFacts = {
  /** An ACTIVE (non-reserved) implementer link is live for this card. */
  hasActiveImplementer: boolean;
  /** Registry `turnEndedAt`; null means no turn end was declared. */
  turnEndedAt: number | null;
  /** Last work granted to the card (spawn, human input or delivery). */
  workGrantedAt: number | null;
};

export function decideCardBusyForReservation(facts: ReservationCardBusyFacts): boolean {
  if (facts.hasActiveImplementer) return true;
  if (facts.turnEndedAt === null) return true;
  // Work granted after the turn end means a new turn is running.
  return facts.workGrantedAt !== null && facts.workGrantedAt > facts.turnEndedAt;
}

/** The first ready reservation (every dependency done) in order, or null. */
export function firstReadyReservation(order: readonly ReservationItem[]): ReservationItem | null {
  for (const item of order) {
    if (item.state !== "reserved") continue;
    if (pendingDeps(item.deps).length === 0) return item;
  }
  return null;
}

/** A ready reservation that does not leave a free card within this window is
 *  reported to the orchestrator once. */
export const RESERVATION_STUCK_MS = 3 * 60_000;
