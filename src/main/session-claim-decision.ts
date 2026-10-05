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
  /** The session's first prompt, when the store exposes it — the content key. */
  firstPrompt?: string | null;
};

export type ReservationView = {
  ownerId: string;
  rearmAtMs: number;
  matchStartMs: number;
  /** The brief the app handed to this card, when known. */
  brief?: string;
};

export type ClaimDecision =
  | { action: "claim"; id: string; confidence?: "paired-by-order" }
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

  if (ours.length === 1) return { action: "claim", id: ours[0]!.id };

  // N cards and N files in the same scope: separate them by CONTENT first. The
  // session's first prompt is the brief the app handed to that card, so a
  // perfect content matching is exact ownership — never a guess.
  if (!input.requiresInputReservation && input.ownerId) {
    const byContent = contentPairingClaim({ open, reservations: input.reservations, ownerId: input.ownerId });
    if (byContent) return { action: "claim", id: byContent };
    // Same brief or no brief at all (a silent card): the only remaining signal
    // is order. Claim, but declare the low confidence so the orchestrator can
    // resolve it by hand.
    const byOrder = orderPairingClaim({
      open,
      reservations: input.reservations,
      ownerId: input.ownerId,
      requiresInputReservation: input.requiresInputReservation,
    });
    if (byOrder) return { action: "claim", id: byOrder, confidence: "paired-by-order" };
  }

  if (sawTie || ours.length > 1) return { action: "none", reason: "ambiguous" };
  return { action: "none", reason: "not-ours" };
}

/** Whitespace-collapsed, trimmed, lower-cased — the shape content is compared
 *  in, so formatting differences do not defeat an exact match. */
function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Two prompts are "the same brief" when they share a long normalized prefix
 *  (the app's brief may carry extra context appended to the task prompt), or
 *  one contains the other when both are short. */
const PROMPT_MATCH_PREFIX = 24;

function promptMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const shortest = Math.min(a.length, b.length);
  if (shortest < PROMPT_MATCH_PREFIX) return a.startsWith(b) || b.startsWith(a);
  return a.slice(0, PROMPT_MATCH_PREFIX) === b.slice(0, PROMPT_MATCH_PREFIX);
}

/**
 * Exact ownership by content: with N owners (each with a brief) and N fresh
 * candidates (each with its first prompt), claim the candidate whose prompt
 * matches this owner's brief, but only when the matching is a PERFECT bijection
 * (every owner matches exactly one candidate and vice versa). Anything less is
 * refused here, so the caller can fall back to order pairing with low
 * confidence. Returns `null` when content cannot decide.
 */
function contentPairingClaim(input: {
  open: readonly SessionCandidateView[];
  reservations: readonly ReservationView[];
  ownerId?: string;
}): string | null {
  if (!input.ownerId || input.open.length < 2) return null;
  const ownerBriefs = new Map<string, string>();
  for (const r of input.reservations) {
    const brief = r.brief ? normalizePrompt(r.brief) : "";
    if (brief) ownerBriefs.set(r.ownerId, brief);
  }
  if (ownerBriefs.size !== input.open.length) return null;
  const ownersForCandidate = new Map<string, string[]>();
  const candidatesForOwner = new Map<string, string[]>();
  for (const candidate of input.open) {
    const prompt = candidate.firstPrompt ? normalizePrompt(candidate.firstPrompt) : "";
    if (!prompt) return null;
    for (const [ownerId, brief] of ownerBriefs) {
      if (!promptMatches(brief, prompt)) continue;
      push(ownersForCandidate, candidate.id, ownerId);
      push(candidatesForOwner, ownerId, candidate.id);
    }
  }
  for (const ids of candidatesForOwner.values()) if (ids.length !== 1) return null;
  for (const owners of ownersForCandidate.values()) if (owners.length !== 1) return null;
  const mine = candidatesForOwner.get(input.ownerId);
  return mine && mine.length === 1 ? mine[0]! : null;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Deterministic 1:1 pairing for N cards and N fresh files, the case where
 * content could not separate them (identical or absent briefs). No per-process
 * evidence exists: the on-disk record carries neither PID nor cwd, and the CLI
 * holds no session file open. So the pairing is an AGGREGATE rule, not an mtime
 * guess: sort the owners by `rearmAtMs` (spawn/input instant, ownerId as the
 * stable tiebreak) and the candidates by `timestampMs` (id as the tiebreak),
 * then pair by index. Every watcher computes the SAME bijection from the same
 * global sets, so each card claims a DISTINCT file and the result is stable as
 * cards claim and release.
 *
 * LOW CONFIDENCE by design: it guarantees N distinct ids, NOT that each file
 * belongs to the card it is paired with. The caller stamps the claim
 * `paired-by-order` so the orchestrator and the human know to verify it.
 */
function orderPairingClaim(input: {
  open: readonly SessionCandidateView[];
  reservations: readonly ReservationView[];
  ownerId?: string;
  requiresInputReservation: boolean;
}): string | null {
  if (input.requiresInputReservation) return null;
  if (!input.ownerId) return null;
  const ownersByLatest = new Map<string, number>();
  for (const r of input.reservations) {
    const current = ownersByLatest.get(r.ownerId);
    if (current === undefined || r.rearmAtMs > current) ownersByLatest.set(r.ownerId, r.rearmAtMs);
  }
  if (ownersByLatest.size < 2 || ownersByLatest.size !== input.open.length) return null;
  const owners = [...ownersByLatest.entries()]
    .map(([ownerId, rearmAtMs]) => ({ ownerId, rearmAtMs }))
    .sort((a, b) => a.rearmAtMs - b.rearmAtMs || compare(a.ownerId, b.ownerId));
  const candidates = [...input.open].sort(
    (a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || compare(a.id, b.id),
  );
  const index = owners.findIndex((o) => o.ownerId === input.ownerId);
  if (index < 0) return null;
  return candidates[index]?.id ?? null;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
