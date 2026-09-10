/**
 * Pure geometry for the radial menu's center-line indicator (RadialMenu.tsx).
 *
 * Extracted so the "sticks to the last pointed item" rule — now an
 * EXPLICIT requirement, see RadialMenu.tsx's file comment for the history
 * — is a plain function with no DOM/React in the way, testable head-on
 * (tests/unit/radial-indicator.test.ts).
 */

/** Angle (radians, atan2 convention) of item `index` out of `count`,
 * evenly spaced around the circle starting at the top (-90°) — must match
 * the placement math RadialMenu.tsx uses to lay the buttons themselves
 * out, or the indicator points between buttons instead of at them. */
export function itemAngle(index: number, count: number): number {
  return (index / count) * Math.PI * 2 - Math.PI / 2;
}

function angularDistance(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  let d = Math.abs(a - b) % twoPi;
  if (d > Math.PI) d = twoPi - d;
  return d;
}

// Review achado 1 — at an angle exactly midway between two adjacent items
// (e.g. raw angle = PI/2 with 11 items: itemAngle(5.5, 11) === PI/2
// exactly, a genuine mathematical tie between item 5 and item 6), the two
// candidate distances differ only by IEEE 754 rounding noise on the order
// of 1e-16 — which one comes out marginally smaller is an accident of
// this specific floating-point subtraction, not a real "nearest" answer,
// and can flip depending on JS engine/platform. A strict `d < bestDist`
// comparison lets that noise silently decide the winner. This epsilon
// makes ties (exact, or within float noise of exact) resolve the SAME
// way every time instead: only replace the current best when a candidate
// is CLEARLY closer, beyond the noise floor; a tie (or a near-tie inside
// it) keeps whichever lower index was already found, since the loop
// visits indices in order. Trade-off, explicit: a genuinely different
// angle that happens to fall within `TIE_EPSILON` (a few billionths of a
// radian — far below anything a real cursor position could produce) of
// an exact tie also resolves to the lower index; at this magnitude that
// never matters in practice.
const TIE_EPSILON = 1e-9;

/** Which item's slice of the circle a raw pointer angle is closest to.
 * Deterministic tie-break: the LOWER index wins (see `TIE_EPSILON` above
 * for why "wins" isn't decided by a raw `<` over floats). */
export function nearestItemIndex(angle: number, count: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < count; i++) {
    const d = angularDistance(angle, itemAngle(i, count));
    if (d < bestDist - TIE_EPSILON) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export type IndicatorDisplay = { visible: false } | { visible: true; angle: number; length: number };

export type IndicatorUpdate = {
  display: IndicatorDisplay;
  /** Next value to carry forward as `lastPointedIndex` in the caller's
   * state — `null` only ever transitions to non-null, never back. */
  lastPointedIndex: number | null;
};

/**
 * One pointer-move step of the indicator state machine.
 *
 * - `dx`/`dy`: cursor position relative to the menu's center (world pixels,
 *   NOT yet an angle) — same inputs `handlePointerMove` already computes.
 * - `itemCount`, `radius`, `ringBand`: current ring's geometry — differs
 *   between the root ring and the terminal-provider submenu (item 2), so
 *   this is never hard-coded here.
 * - `lastPointedIndex`: the item the cursor was last confirmed to be near,
 *   from the previous call (or `null` before the pointer has ever entered
 *   the ring band since the menu/level opened).
 *
 * "Apontou para o item" — the criterion decided for this feature — is
 * simply "cursor within `ringBand` of `radius` from the center": the same
 * band the old accidental-freeze implementation used to gate its updates,
 * now used on purpose to gate which item counts as pointed-at, not just
 * whether the indicator refreshes. While inside the band the line follows
 * the cursor's raw angle (smooth); the instant it leaves, the line snaps
 * to point exactly at the last item's own angle instead of freezing on
 * whatever raw angle the cursor last had (which is what made the old
 * behavior an accident of `RING_BAND`-gated updates rather than a rule).
 * Before the cursor has ever been in the band, nothing is shown.
 *
 * Known, accepted limitation (review flagged it, decided not worth
 * fixing): each call is independent — there is no memory of the path
 * between one `pointermove` and the next. A fast enough real movement can
 * cross several items' sectors within a single browser-coalesced frame;
 * only wherever the cursor happened to sample on the LATEST event updates
 * `lastPointedIndex` — an item physically swept over in between is never
 * recorded as pointed-at. Fixing this would mean tracking (and re-testing
 * a hit against) every intermediate position between two `pointermove`
 * events, which the browser doesn't even guarantee delivering for a fast
 * move — disproportionate complexity for what is a purely cosmetic
 * indicator line, not a hit-test that gates an action.
 */
export function computeIndicator(
  dx: number,
  dy: number,
  itemCount: number,
  radius: number,
  ringBand: number,
  lastPointedIndex: number | null,
): IndicatorUpdate {
  const dist = Math.hypot(dx, dy);
  const inBand = Math.abs(dist - radius) <= ringBand;

  if (inBand) {
    const angle = Math.atan2(dy, dx);
    const pointedIndex = nearestItemIndex(angle, itemCount);
    return {
      display: { visible: true, angle, length: Math.min(dist, radius) },
      lastPointedIndex: pointedIndex,
    };
  }

  if (lastPointedIndex !== null) {
    return {
      display: { visible: true, angle: itemAngle(lastPointedIndex, itemCount), length: radius },
      lastPointedIndex,
    };
  }

  return { display: { visible: false }, lastPointedIndex: null };
}
