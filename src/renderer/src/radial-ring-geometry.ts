/**
 * Pure ring-sizing math for the dual-ring radial menu (RadialMenu.tsx).
 * Radii and node sizes match docs/design/app-v3/prototipo/Radial.dc.html.
 * Viewport clamp takes the outer spawn ring (and optional provider arc) so
 * the menu stays on-screen near window edges.
 */

/** Inner dashed tool ring (V/P/C/S). */
export const INNER_RADIUS = 95;
/** Outer spawn ring (actions 1–8). */
export const OUTER_RADIUS = 180;
/** Provider arc radius when the agent submenu is open. */
export const PROVIDER_RADIUS = 285;
/** @deprecated Use OUTER_RADIUS — kept for smoke scripts that imported BASE_RADIUS. */
export const BASE_RADIUS = OUTER_RADIUS;

export const TOOL_ITEM_SIZE = 38;
export const SPAWN_ITEM_SIZE = 54;
export const PROVIDER_ITEM_SIZE = 40;
export const CENTER_HUB_SIZE = 112;

/** Provider arc span (prototype: −40° … +40°). */
export const PROVIDER_ARC_START_DEG = -40;
export const PROVIDER_ARC_END_DEG = 40;
/** Step when there are exactly five providers (prototype P[]). */
export const PROVIDER_ARC_STEP_DEG = 20;

export const EDGE_MARGIN = 8;

/** Convert prototype degrees (0° = top) to canvas position relative to center. */
export function polarOffset(radius: number, deg: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: radius * Math.cos(a), y: radius * Math.sin(a) };
}

export function toolAngleDeg(index: number): number {
  return 45 + index * 90;
}

export function spawnAngleDeg(index: number): number {
  return index * 45;
}

/**
 * Evenly space `count` providers across −40°…+40°. With five items this
 * matches the prototype's −40 + i×20; with more/fewer it stays inside the
 * arc instead of walking past +40° (which pushed later nodes above Claude).
 */
export function providerAngleDeg(index: number, count = 5): number {
  if (count <= 1) return 0;
  return PROVIDER_ARC_START_DEG + (index / (count - 1)) * (PROVIDER_ARC_END_DEG - PROVIDER_ARC_START_DEG);
}

/**
 * Farthest radial extent from center (node edge) for clamp math.
 * When the provider arc is open, that ring wins; otherwise the spawn ring.
 */
export function menuExtentRadius(providerArcOpen: boolean): number {
  if (providerArcOpen) return PROVIDER_RADIUS + PROVIDER_ITEM_SIZE / 2;
  return OUTER_RADIUS + SPAWN_ITEM_SIZE / 2;
}

export function clampOpenPoint(
  x: number,
  y: number,
  extentRadius: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const margin = extentRadius + EDGE_MARGIN;
  return {
    x: clampAxis(x, margin, viewportWidth),
    y: clampAxis(y, margin, viewportHeight),
  };
}

function clampAxis(pos: number, margin: number, viewportSize: number): number {
  if (viewportSize <= margin * 2) return viewportSize / 2;
  return Math.min(Math.max(pos, margin), viewportSize - margin);
}

export type RingGeometry = {
  x: number;
  y: number;
  innerRadius: number;
  outerRadius: number;
  providerRadius: number;
  toolSize: number;
  spawnSize: number;
  providerSize: number;
  hubSize: number;
};

/**
 * Resolve where the dual-ring menu actually renders. Prefer the requested
 * open point; near an edge, pull the center inward so the active extent fits.
 */
export function resolveRingGeometry(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  providerArcOpen = false,
): RingGeometry {
  const extent = menuExtentRadius(providerArcOpen);
  const center = clampOpenPoint(x, y, extent, viewportWidth, viewportHeight);
  return {
    x: center.x,
    y: center.y,
    innerRadius: INNER_RADIUS,
    outerRadius: OUTER_RADIUS,
    providerRadius: PROVIDER_RADIUS,
    toolSize: TOOL_ITEM_SIZE,
    spawnSize: SPAWN_ITEM_SIZE,
    providerSize: PROVIDER_ITEM_SIZE,
    hubSize: CENTER_HUB_SIZE,
  };
}
