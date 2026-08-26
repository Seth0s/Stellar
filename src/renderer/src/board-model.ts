// Pure, React-free board geometry — the coordinate system every board item
// (terminal today; files/annotation/browser later) shares. Kept separate so
// new item kinds don't reimplement drag/resize/z-order/culling math.

export type BoardItemKind = "terminal" | "files" | "changes" | "sticky" | "browser" | "stroke";

export type Rect = { x: number; y: number; w: number; h: number };

export type BoardItem = {
  id: string;
  kind: BoardItemKind;
  rect: Rect;
};

export type WorldTransform = { panX: number; panY: number; zoom: number };

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** AABB visibility test — is `rect` at least partially inside `viewport`? */
export function isInView(rect: Rect, viewport: Rect): boolean {
  return rectsOverlap(rect, viewport);
}

/** Screen-space point (relative to the viewport element) -> world-space point. */
export function screenToWorld(screen: { x: number; y: number }, world: WorldTransform): { x: number; y: number } {
  return {
    x: (screen.x - world.panX) / world.zoom,
    y: (screen.y - world.panY) / world.zoom,
  };
}

/** The world-space rect currently visible through a viewport of the given screen size. */
export function viewportWorldRect(viewportSize: { width: number; height: number }, world: WorldTransform): Rect {
  const topLeft = screenToWorld({ x: 0, y: 0 }, world);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: viewportSize.width / world.zoom,
    h: viewportSize.height / world.zoom,
  };
}

/** Topmost item (by z-order) whose rect contains `point`, or null. */
export function hitTest(items: BoardItem[], point: { x: number; y: number }, order: string[]): BoardItem | null {
  const byId = new Map(items.map((it) => [it.id, it]));
  for (let i = order.length - 1; i >= 0; i--) {
    const item = byId.get(order[i]);
    if (!item) continue;
    const { rect } = item;
    if (point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h) {
      return item;
    }
  }
  return null;
}

// Sized so a freshly spawned terminal lands close to 80×24 (the PTY's own
// initial size — DEFAULT_COLS/ROWS in useTerminal.ts) instead of squeezing
// it to ~47×15: most CLI TUIs (Claude Code, Codex, Cursor) assume something
// near a standard terminal width and render broken/wrapped box drawing well
// below that. Confirmed empirically via CDP: 440×380 (the old default)
// measured out to 47 cols × 15 rows.
const SPAWN_W = 720;
const SPAWN_H = 560;

/**
 * Cascading default position for the n-th item created, anchored at a fixed
 * world-space origin. Only used for the very first card of a brand new
 * board (see App.tsx's loadBoard) — the world transform has just been reset
 * to identity right before that, so world-space origin and screen origin
 * coincide anyway. Every other spawn path uses `centeredSlot` below.
 */
export function cascadeSlot(index: number): Rect {
  return {
    x: 40 + (index % 3) * 740,
    y: 40 + Math.floor(index / 3) * 580,
    w: SPAWN_W,
    h: SPAWN_H,
  };
}

/**
 * Default position for the n-th item created via a rail button, centered on
 * whatever part of the board the user is actually looking at (`visibleRect`
 * — the world-space rect the viewport currently shows) instead of a fixed
 * world-space origin. `cascadeSlot` planted every new card at the same
 * (40,40)-anchored spot regardless of where the user had panned/zoomed to —
 * fine the first few times, but once the user had panned away, a new card
 * (especially a browser card: a native WebContentsView, which paints above
 * every DOM element regardless of z-index) could land stacked exactly on
 * top of an existing card far outside the visible area, or directly over
 * one still in view, visually swallowing it. Small per-index stagger (same
 * idea as cascadeSlot, just centered) so several quick spawns still fan out
 * instead of exact-stacking; cycles every 5 so it never drifts off the
 * visible area after many spawns.
 */
export function centeredSlot(visibleRect: Rect, index: number): Rect {
  const cx = visibleRect.x + visibleRect.w / 2;
  const cy = visibleRect.y + visibleRect.h / 2;
  const stagger = (index % 5) * 36;
  return {
    x: cx - SPAWN_W / 2 + stagger,
    y: cy - SPAWN_H / 2 + stagger,
    w: SPAWN_W,
    h: SPAWN_H,
  };
}

/** Default position for a card spawned at a specific world point — the
 * radial menu (item 1) opens at the cursor and should plant the new card
 * right there, not back at the viewport center like `centeredSlot`. No
 * stagger: this only ever spawns one card per invocation. */
export function pointSlot(point: Point): Rect {
  return { x: point.x - SPAWN_W / 2, y: point.y - SPAWN_H / 2, w: SPAWN_W, h: SPAWN_H };
}

/**
 * World-space rect -> window-content pixel rect. A native WebContentsView
 * is positioned in absolute window pixels, outside the DOM/CSS transform
 * that every other card rides for free — this is the math a browser card
 * has to redo by hand whenever its rect, or the world pan/zoom, changes.
 */
export function worldRectToScreen(rect: Rect, world: WorldTransform, viewportOrigin: { x: number; y: number }): Rect {
  return {
    x: viewportOrigin.x + world.panX + rect.x * world.zoom,
    y: viewportOrigin.y + world.panY + rect.y * world.zoom,
    w: rect.w * world.zoom,
    h: rect.h * world.zoom,
  };
}

function intersectRects(a: Rect, b: Rect): Rect {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Clips a browser card's screen-space bounds to the visible viewport, below
 * the floating topbar and to the right of the icon rail. A WebContentsView
 * paints above every DOM element regardless of z-index — without this
 * clamp it would cover that chrome (or spill outside the window) whenever
 * panned/zoomed underneath it. Returns null when nothing visible remains —
 * the caller should hide the view instead of setting a degenerate/
 * negative-size rect.
 */
export function clampBrowserBounds(
  screenRect: Rect,
  viewportScreenRect: Rect,
  insets: { top: number; left: number },
): Rect | null {
  const clipped = intersectRects(screenRect, {
    x: viewportScreenRect.x + insets.left,
    y: viewportScreenRect.y + insets.top,
    w: viewportScreenRect.w - insets.left,
    h: viewportScreenRect.h - insets.top,
  });
  if (clipped.w <= 0 || clipped.h <= 0) return null;
  return clipped;
}

export type Point = { x: number; y: number };

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Bounding box of a set of rects, or null for an empty board — used by fitView. */
export function bboxOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Control point for a quadratic bezier bowed away from the straight line between `from` and `to`, by `bow` × its length. */
export function quadraticControlPoint(from: Point, to: Point, bow = 0.18): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  if (len === 0) return { x: mx, y: my };
  const nx = -dy / len;
  const ny = dx / len;
  return { x: mx + nx * len * bow, y: my + ny * len * bow };
}

/**
 * Where the segment from `from` to `to` first exits `rect`, assuming `from`
 * is inside it (true for every call site here — `from` is always that
 * rect's own center). Used to clip a connector's end to the edge of its
 * card instead of drawing through its middle. Falls back to `to` itself if
 * the segment is degenerate or never crosses a finite edge span.
 */
export function clipLineToRect(from: Point, to: Point, rect: Rect): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  const candidates: number[] = [];
  if (dx !== 0) {
    const tLeft = (x1 - from.x) / dx;
    const yAtLeft = from.y + tLeft * dy;
    if (tLeft > 0 && tLeft <= 1 && yAtLeft >= y1 && yAtLeft <= y2) candidates.push(tLeft);
    const tRight = (x2 - from.x) / dx;
    const yAtRight = from.y + tRight * dy;
    if (tRight > 0 && tRight <= 1 && yAtRight >= y1 && yAtRight <= y2) candidates.push(tRight);
  }
  if (dy !== 0) {
    const tTop = (y1 - from.y) / dy;
    const xAtTop = from.x + tTop * dx;
    if (tTop > 0 && tTop <= 1 && xAtTop >= x1 && xAtTop <= x2) candidates.push(tTop);
    const tBottom = (y2 - from.y) / dy;
    const xAtBottom = from.x + tBottom * dx;
    if (tBottom > 0 && tBottom <= 1 && xAtBottom >= x1 && xAtBottom <= x2) candidates.push(tBottom);
  }
  const t = candidates.length > 0 ? Math.min(...candidates) : 1;
  return { x: from.x + t * dx, y: from.y + t * dy };
}
