/**
 * Pure claim arbitration for on-disk session discovery.
 *
 * Two cards on the same cwd+provider can see the same unowned files.
 * Picking "the newest mtime" is the current bug — a guess that silently
 * stamps the wrong `resume_id`. If two unowned candidates exist and
 * nothing else distinguishes them, claim none and leave the id for the
 * manual action.
 *
 * Timeouts / grace windows are not inputs here: a clock only changes
 * the probability of guessing. Ownership evidence is (1) an input
 * reservation (this card typed, the file appeared after that input)
 * and (2) uniqueness (exactly one candidate assigned to this owner).
 */

export type SessionCandidateView = {
  id: string;
  timestampMs?: number;
};

export type ReservationView = {
  ownerId: string;
  rearmAtMs: number;
  matchStartMs: number;
};

export type ClaimDecision =
  | { action: "claim"; id: string }
  | { action: "none"; reason: "no-candidates" | "ambiguous" | "awaiting-input" | "not-ours" };

function newestReservationFor(
  candidate: SessionCandidateView,
  reservations: readonly ReservationView[],
): ReservationView | "tie" | null {
  if (candidate.timestampMs === undefined) return null;
  let bestAt = -Infinity;
  const best: ReservationView[] = [];
  for (const reservation of reservations) {
    if (candidate.timestampMs <= reservation.matchStartMs) continue;
    if (reservation.rearmAtMs > bestAt) {
      bestAt = reservation.rearmAtMs;
      best.length = 0;
      best.push(reservation);
    } else if (reservation.rearmAtMs === bestAt) {
      best.push(reservation);
    }
  }
  if (best.length === 0) return null;
  const owners = new Set(best.map((r) => r.ownerId));
  if (owners.size > 1) return "tie";
  return best[0]!;
}

export function decideClaimAmongCandidates(input: {
  candidates: readonly SessionCandidateView[];
  isClaimed: (id: string) => boolean;
  ownerId?: string;
  reservations: readonly ReservationView[];
  /**
   * Providers that only write the session record AFTER a prompt
   * (antigravity, opencode — measured). A spawn-time poller must not
   * claim a file that appeared because a sibling card received input.
   */
  requiresInputReservation: boolean;
}): ClaimDecision {
  const open = input.candidates.filter((c) => !input.isClaimed(c.id));
  if (open.length === 0) return { action: "none", reason: "no-candidates" };

  const ownerReservations = input.ownerId
    ? input.reservations.filter((r) => r.ownerId === input.ownerId)
    : [];

  if (input.requiresInputReservation && ownerReservations.length === 0) {
    return { action: "none", reason: "awaiting-input" };
  }

  if (input.reservations.length === 0) {
    if (open.length === 1) return { action: "claim", id: open[0]!.id };
    return { action: "none", reason: "ambiguous" };
  }

  const ours: SessionCandidateView[] = [];
  let sawTie = false;
  for (const candidate of open) {
    const assigned = newestReservationFor(candidate, input.reservations);
    if (assigned === "tie") {
      sawTie = true;
      continue;
    }
    if (assigned && input.ownerId && assigned.ownerId === input.ownerId) {
      ours.push(candidate);
    }
  }

  if (sawTie) return { action: "none", reason: "ambiguous" };
  if (ours.length === 1) return { action: "claim", id: ours[0]!.id };
  if (ours.length > 1) return { action: "none", reason: "ambiguous" };
  return { action: "none", reason: "not-ours" };
}
