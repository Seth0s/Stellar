/**
 * DESIGN-BACKLOG.md §2.0 item 5 — whether `openBrowserFor` should navigate
 * an existing browser card owned by the caller, or always create a new one.
 *
 * Defaults:
 * - Human (`ownerCardId === null`): never reuse. Every null-owner used to
 *   share one card, so a chip click "opened" nothing visible.
 * - Agent (non-null owner): reuse unless the caller passes `reuse: false`.
 *   Keeps `open_url` from cluttering the board on every navigation while
 *   still letting the caller opt into a second window.
 */
export function decideBrowserReuse(ownerCardId: string | null, reuse?: boolean): boolean {
  if (ownerCardId === null) return false;
  return reuse !== false;
}

/** The slice of a live card this decision needs: enough to tell a browser
 * from anything else and to know who owns it. `ownerCardId` only exists on
 * browser cards (`BrowserCardData`); every other kind passes `null`. */
export interface BrowserCardCandidate {
  id: string;
  kind: string;
  ownerCardId?: string | null;
}

export type BrowserOpenDecision =
  /** Create a fresh browser card owned by the caller. */
  | { action: "new" }
  /** Navigate this existing card — the caller's own browser, chosen on purpose. */
  | { action: "reuse"; cardId: string }
  /**
   * Refuse, naming why. Callers must surface this to whoever asked and
   * navigate NOTHING: the old "first browser by insertion order" `find` would
   * silently navigate a different card than the one requested (P1, measured
   * on the IdyPlatform board: an agent owning a reference prototype AND a
   * logged-in Admin app had the prototype hijacked by every default
   * `open_url`).
   */
  | { action: "refuse"; error: string };

/**
 * Decide WHICH browser card a request navigates, deterministically.
 *
 * Two caller choices, in priority order:
 *  1. `targetCardId` — an explicit card named by the caller (`open_url`'s
 *     `cardId`). It wins over everything and is honored only if it exists,
 *     is a browser, and belongs to the caller; otherwise the request is
 *     REFUSED with a reason, never redirected to a different card.
 *  2. no target — reuse the caller's MOST RECENTLY FOCUSED browser (highest
 *     z-order index in `order`), falling back to the most recently CREATED
 *     when `order` is unavailable. This replaces the old
 *     "first match by insertion order" rule, which was arbitrary: with two
 *     owned browsers it always picked the OLDEST.
 *
 * `ownerCardId === null` (a human) and `reuse: false` both mean "new card",
 * exactly as `decideBrowserReuse` already encoded.
 */
export function decideBrowserOpen(
  ownerCardId: string | null,
  cards: readonly BrowserCardCandidate[],
  opts?: { reuse?: boolean; targetCardId?: string | null; order?: readonly string[] },
): BrowserOpenDecision {
  const targetCardId = opts?.targetCardId ?? null;

  if (targetCardId !== null && targetCardId.length > 0) {
    if (opts?.reuse === false) {
      return {
        action: "refuse",
        error: `cardId "${targetCardId}" names an existing card to navigate, but reuse:false asks for a NEW one — drop one of the two`,
      };
    }
    const target = cards.find((c) => c.id === targetCardId);
    if (!target) {
      return {
        action: "refuse",
        error: `cardId "${targetCardId}" is not a card on this board — check list_cards for a live id`,
      };
    }
    if (target.kind !== "browser") {
      return {
        action: "refuse",
        error: `cardId "${targetCardId}" is a ${target.kind} card, not a browser — open_url only navigates browser cards`,
      };
    }
    if ((target.ownerCardId ?? null) !== ownerCardId) {
      const owner =
        target.ownerCardId === null || target.ownerCardId === undefined
          ? "a human (it has no owner)"
          : `card "${target.ownerCardId}"`;
      return {
        action: "refuse",
        error: `browser card "${targetCardId}" belongs to ${owner}, not to you — open_url only reuses a browser YOU own`,
      };
    }
    return { action: "reuse", cardId: target.id };
  }

  if (!decideBrowserReuse(ownerCardId, opts?.reuse)) return { action: "new" };

  const owned = cards.filter((c) => c.kind === "browser" && (c.ownerCardId ?? null) === ownerCardId);
  if (owned.length === 0) return { action: "new" };

  const order = opts?.order ?? [];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? -1 : i;
  };
  let best = owned[0];
  for (const candidate of owned) {
    if (rank(candidate.id) >= rank(best.id)) best = candidate;
  }
  return { action: "reuse", cardId: best.id };
}
