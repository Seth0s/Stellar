/**
 * Pure ring-sizing math for the radial menu (RadialMenu.tsx): how big the
 * ring's radius wants to be for a given item count, where the ring's
 * center actually lands once the viewport is taken into account, and how
 * big each item renders. Extracted into its own module for the same
 * reason radial-indicator.ts and radial-providers.ts already are:
 * testable head-on in `environment: "node"` (vitest.config.ts), no
 * DOM/`window` mock needed — every function here takes the viewport's
 * width/height as plain parameters instead of reading
 * `window.innerWidth`/`innerHeight` itself; RadialMenu.tsx passes those
 * in.
 */

export const BASE_RADIUS = 88;

// Review achado 2 — the root ring is always exactly 11 fixed items
// (never overlaps at BASE_RADIUS, see RadialMenu.tsx's ACTIONS), but
// item 2's provider submenu is only as long as `providers` — today 6
// (+ "voltar" = 7), comfortable, but nothing caps it. Past ~16 items at
// a fixed BASE_RADIUS the 40px icons start overlapping (circumference /
// count drops below the icon's own footprint). Rather than an arbitrary
// count cap that silently drops/hides providers past some N (which
// would also make item positions depend on which providers are
// installed — the exact "menu shifts under muscle memory" problem the
// disabled-not-hidden decision in RadialMenu.tsx's `renderProviderItems`
// already avoids), the ring's radius grows to keep a minimum arc length
// per item; it never shrinks below BASE_RADIUS, so today's actual counts
// (11 root, 7 provider) render identically to before this change.
export const MIN_ITEM_ARC = 44; // px of ring circumference per item — the 40px icon footprint plus a visible gap

export function idealRadiusFor(itemCount: number): number {
  return Math.max(BASE_RADIUS, (MIN_ITEM_ARC * itemCount) / (Math.PI * 2));
}

export const BASE_ITEM_SIZE = 40; // px — matches `.radial-item`'s own base width/height in layout.css
export const ITEM_GAP = 4; // px of breathing room between two adjacent items' edges
export const EDGE_MARGIN = 8; // px between an item's outer edge and the window's edge

/**
 * Review round 3 (the round that mattered): rounds 2's fix capped the
 * ring's RADIUS to whatever the viewport allowed near an edge, floored
 * so it wouldn't collapse to 0 — except the floor didn't stop overlap,
 * it just guaranteed a small, EVENLY OVERLAPPING ring instead (11 items
 * at a 28px floor radius: ~16px between centers, but each item is
 * itself 28px wide — 12px of real, measured overlap). A floor on the
 * radius alone can't fix that; the fix has to change WHERE the ring's
 * center goes, not just how small it's allowed to get.
 *
 * So: clamp the OPENING POINT inward instead, far enough from every edge
 * that a `radius`-sized ring (plus half an item's own footprint, plus
 * `EDGE_MARGIN`) fits entirely on-screen from wherever it ends up. Same
 * trade-off any context menu already makes when you right-click near a
 * screen edge: it opens offset from the cursor, not centered under it.
 *
 * Consequence, worth documenting because it's surprising: this means
 * the ring's center — where the item-1 indicator LINE starts — is no
 * longer guaranteed to be the point the user actually clicked, once
 * that click was near an edge. Someone will notice the line doesn't
 * originate exactly under their cursor near a window edge and wonder if
 * that's a bug; it's this clamp, on purpose.
 *
 * If a viewport axis is itself too small to fit `radius` even from its
 * own center (a genuinely tiny window, not just a click near the edge of
 * a normal one), clamping alone can't help — that axis centers as a
 * best effort, and `resolveRingGeometry` below is the one that actually
 * shrinks `radius` (and, critically, the item size along with it) for
 * that remaining case.
 */
export function clampOpenPoint(
  x: number,
  y: number,
  radius: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const margin = radius + BASE_ITEM_SIZE / 2 + EDGE_MARGIN;
  return {
    x: clampAxis(x, margin, viewportWidth),
    y: clampAxis(y, margin, viewportHeight),
  };
}

function clampAxis(pos: number, margin: number, viewportSize: number): number {
  // The axis itself is narrower than what two margins would need — no
  // clamp position keeps the whole ring on-screen along this axis, so
  // center it as the least-bad option; `resolveRingGeometry`'s radius
  // shrink is what actually keeps items from overlapping in this case.
  if (viewportSize <= margin * 2) return viewportSize / 2;
  return Math.min(Math.max(pos, margin), viewportSize - margin);
}

/** The largest radius that fits entirely within the viewport from a
 * given (already clamped, in the normal case) center point — the
 * distance to the nearest of the four edges, minus half an item's
 * footprint and `EDGE_MARGIN`. No floor: unlike round 2's
 * `viewportMaxRadius`, flooring this is exactly what produced the
 * overlapping ring — see `clampOpenPoint`'s doc comment above for why
 * moving the CENTER is the fix instead. Can legitimately return a small
 * or even ~0 value for a genuinely tiny viewport; `itemSizeFor` is what
 * keeps items from overlapping at whatever radius this ends up being. */
export function maxRadiusFrom(x: number, y: number, viewportWidth: number, viewportHeight: number): number {
  const clearance = Math.min(x, viewportWidth - x, y, viewportHeight - y);
  return Math.max(0, clearance - BASE_ITEM_SIZE / 2 - EDGE_MARGIN);
}

/**
 * Item diameter for `itemCount` items evenly spaced around a ring of
 * `radius`. The one invariant that actually matters — `itemSize` never
 * exceeds the arc of ring circumference available to each item (minus
 * `ITEM_GAP` breathing room) — holds unconditionally, by construction:
 * there is no floor pushing the returned size back UP past what the arc
 * can hold, unlike round 2's version of this function (which had exactly
 * that bug — `Math.max(ITEM_SIZE_FLOOR, ...)` around this same
 * computation, guaranteeing overlap the moment the arc got smaller than
 * the floor). Preferring `BASE_ITEM_SIZE` and only shrinking below it
 * when the arc demands it is as far as this function goes; keeping
 * items comfortably sized in the first place is `resolveRingGeometry`'s
 * job (clamp the point, prefer `idealRadiusFor`), not this one's.
 */
export function itemSizeFor(itemCount: number, radius: number): number {
  const arcPerItem = (Math.PI * 2 * radius) / itemCount;
  return Math.max(0, Math.min(BASE_ITEM_SIZE, arcPerItem - ITEM_GAP));
}

export type RingGeometry = { x: number; y: number; radius: number; itemSize: number };

/**
 * The full resolution RadialMenu.tsx needs: given where the menu was
 * asked to open (`x`, `y` — e.g. the right-click/long-press point) and
 * how many items it needs to arrange, produce the ACTUAL center to
 * render at, the ring's radius, and each item's size — never
 * overlapping, never off-screen unless the viewport itself is too small
 * to avoid it.
 *
 * Order of preference: (1) `idealRadiusFor`'s comfortable radius, ring
 * centered wherever it was asked to open, if the viewport allows it
 * outright; (2) same radius, center clamped inward near an edge — the
 * normal case this whole module exists for; (3) only if the viewport
 * itself is too small even for a clamped, centered ring — shrink the
 * radius (and therefore, via `itemSizeFor`, the item size) as the last
 * resort, together, so `itemSize <= arcPerItem` never breaks.
 */
export function resolveRingGeometry(
  x: number,
  y: number,
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number,
): RingGeometry {
  const ideal = idealRadiusFor(itemCount);
  const center = clampOpenPoint(x, y, ideal, viewportWidth, viewportHeight);
  const radius = Math.min(ideal, maxRadiusFrom(center.x, center.y, viewportWidth, viewportHeight));
  const itemSize = itemSizeFor(itemCount, radius);
  return { x: center.x, y: center.y, radius, itemSize };
}
