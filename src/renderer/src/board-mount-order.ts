import { type Rect } from "./board-model";

/**
 * Concurrent heavy card mounts allowed while a board is opening. Measured
 * (docs/PERF.md §17): mounting everything at once produced ~739 ms of
 * consecutive longtasks and hit Chromium's 16 WebGL-context cap; two at a
 * time keeps each slice under ~70 ms and leaves the UI responsive.
 */
export const BOARD_MOUNT_CEILING = 2;

export type MountCandidate = {
  id: string;
  rect: Rect;
  /** Top of the z-order — the card the user was last interacting with. */
  focused: boolean;
  inView: boolean;
};

function centerDistanceSq(rect: Rect, center: { x: number; y: number }): number {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = cx - center.x;
  const dy = cy - center.y;
  return dx * dx + dy * dy;
}

/**
 * Mount order for a board open: focused card first, then cards overlapping
 * the viewport (nearest to the viewport center first), then off-screen
 * cards (also nearest-first so a small pan can finish them early).
 */
export function orderBoardMount(
  cards: readonly MountCandidate[],
  viewportCenter: { x: number; y: number },
): string[] {
  const focused: MountCandidate[] = [];
  const visible: MountCandidate[] = [];
  const offscreen: MountCandidate[] = [];
  for (const card of cards) {
    if (card.focused) focused.push(card);
    else if (card.inView) visible.push(card);
    else offscreen.push(card);
  }
  const byDistance = (a: MountCandidate, b: MountCandidate) =>
    centerDistanceSq(a.rect, viewportCenter) - centerDistanceSq(b.rect, viewportCenter);
  visible.sort(byDistance);
  offscreen.sort(byDistance);
  return [...focused, ...visible, ...offscreen].map((c) => c.id);
}

/**
 * How many not-yet-released ids may start mounting now, given the ceiling
 * and how many released cards are still in flight (released but not ready).
 */
export function nextMountReleases(
  ordered: readonly string[],
  released: ReadonlySet<string>,
  ready: ReadonlySet<string>,
  ceiling: number = BOARD_MOUNT_CEILING,
): string[] {
  let inFlight = 0;
  for (const id of released) {
    if (!ready.has(id)) inFlight += 1;
  }
  const slots = Math.max(0, ceiling - inFlight);
  if (slots === 0) return [];
  const out: string[] = [];
  for (const id of ordered) {
    if (released.has(id)) continue;
    out.push(id);
    if (out.length >= slots) break;
  }
  return out;
}
