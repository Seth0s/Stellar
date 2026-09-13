/**
 * Geometry of the terminal activity-bar sweep (TerminalCard.module.css).
 *
 * The strip is `ACTIVITY_SWEEP_WIDTH_RATIO` of the bar. It starts at
 * `left: -width` (fully off the left). `translateX` is a percentage of
 * the strip itself, so card-travel = translate × width-ratio.
 *
 * `translateX(200%)` therefore only walks 68% of the card — the
 * photographed freeze: the animation eases to a stop short of the
 * right edge and sits there. The CSS now moves by `100cqi + 100%`
 * (one card width plus the strip) so the right edge exits the bar.
 */

export const ACTIVITY_SWEEP_WIDTH_RATIO = 0.34;

/** How far across the card (0–100) a `translateX(percentOfSelf)` travels. */
export function activitySweepCardTravelPercent(translatePercentOfSelf: number): number {
  return translatePercentOfSelf * ACTIVITY_SWEEP_WIDTH_RATIO;
}

/**
 * `translateX` percent-of-self that puts the strip's RIGHT edge at
 * `endAtCard` (1 = the bar's right edge, 1 + width-ratio = fully off).
 */
export function activitySweepTranslatePercent(endAtCard = 1): number {
  return (endAtCard / ACTIVITY_SWEEP_WIDTH_RATIO) * 100;
}
