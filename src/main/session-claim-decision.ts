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

/**
 * Manual identify disambiguation for a LIVE card process.
 *
 * Unlike `decideClaimAmongCandidates` (file-only, no process), this is a
 * human gesture on one specific card: the process IS the session. Open
 * file descriptors (Linux `/proc/<pid>/fd`) are exact ownership — not an
 * mtime guess. Cmdline `--resume` / `--session-id` is the same fact when
 * the CLI was started with an imposed id. A process-birth window only
 * DROPS candidates created before the process existed; if two remain,
 * refuse and let the human pick (still not "newest mtime wins").
 *
 * macOS: callers pass empty `openSessionIds` / omit start time when
 * `/proc` is unavailable — this function then keeps the refusal (or
 * unique/cmdline paths) without pretending fd evidence exists.
 */
export type IdentifyProcessEvidence = {
  openSessionIds: readonly string[];
  cmdlineSessionIds?: readonly string[];
  /** Epoch ms when the card process started. Used only as a lower bound. */
  processStartedAtMs?: number;
};

export type IdentifyCandidateForDecision = {
  id: string;
  /** Session record creation time (meta.createdAtMs / file birth), not mtime. */
  createdAtMs?: number;
};

export type IdentifyProcessDecision =
  | { action: "claim"; id: string; via: "open-fd" | "cmdline" | "process-birth-window" | "unique" }
  | { action: "ambiguous"; ids: string[] }
  | { action: "none" };

export function decideIdentifyByProcessEvidence(input: {
  candidates: readonly IdentifyCandidateForDecision[];
  evidence: IdentifyProcessEvidence;
}): IdentifyProcessDecision {
  const { candidates, evidence } = input;
  if (candidates.length === 0) return { action: "none" };
  if (candidates.length === 1) {
    return { action: "claim", id: candidates[0]!.id, via: "unique" };
  }

  const candidateIds = new Set(candidates.map((c) => c.id));

  const openHits = uniqueInSet(evidence.openSessionIds, candidateIds);
  if (openHits.length === 1) return { action: "claim", id: openHits[0]!, via: "open-fd" };
  if (openHits.length > 1) return { action: "ambiguous", ids: openHits };

  const cmdlineHits = uniqueInSet(evidence.cmdlineSessionIds ?? [], candidateIds);
  if (cmdlineHits.length === 1) return { action: "claim", id: cmdlineHits[0]!, via: "cmdline" };
  if (cmdlineHits.length > 1) return { action: "ambiguous", ids: cmdlineHits };

  const started = evidence.processStartedAtMs;
  if (started !== undefined) {
    const afterBirth = candidates.filter(
      (c) => c.createdAtMs !== undefined && c.createdAtMs >= started,
    );
    if (afterBirth.length === 1) {
      return { action: "claim", id: afterBirth[0]!.id, via: "process-birth-window" };
    }
    if (afterBirth.length > 1) {
      // Two sessions born after this process — still refuse. Do NOT pick
      // by mtime among the survivors; the human gesture can choose.
      return { action: "ambiguous", ids: afterBirth.map((c) => c.id) };
    }
  }

  return { action: "ambiguous", ids: candidates.map((c) => c.id) };
}

function uniqueInSet(ids: readonly string[], allowed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
