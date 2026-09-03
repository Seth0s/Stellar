import { describe, it, expect } from "vitest";
import {
  rectsOverlap,
  overlapArea,
  isInView,
  screenToWorld,
  viewportWorldRect,
  worldRectToScreen,
  rectCenter,
  bboxOf,
  quadraticControlPoint,
  clipLineToRect,
  cascadeSlot,
  centeredSlot,
  pointSlot,
  hitTest,
  type Rect,
  type WorldTransform,
  type BoardItem,
} from "../../src/renderer/src/board-model";

describe("board-model geometry", () => {
  it("detects overlapping and non-overlapping rectangles", () => {
    const r1: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const r2: Rect = { x: 50, y: 50, w: 100, h: 100 };
    const r3: Rect = { x: 200, y: 200, w: 50, h: 50 };

    expect(rectsOverlap(r1, r2)).toBe(true);
    expect(isInView(r1, r2)).toBe(true);
    expect(rectsOverlap(r1, r3)).toBe(false);
    expect(isInView(r1, r3)).toBe(false);
  });

  it("converts screen coords to world coords correctly", () => {
    const world: WorldTransform = { panX: 100, panY: 50, zoom: 2 };
    const screenPoint = { x: 300, y: 250 };
    const worldPoint = screenToWorld(screenPoint, world);

    // (300 - 100) / 2 = 100
    // (250 - 50) / 2 = 100
    expect(worldPoint).toEqual({ x: 100, y: 100 });
  });

  it("computes visible world rect from viewport screen size", () => {
    const world: WorldTransform = { panX: 0, panY: 0, zoom: 0.5 };
    const viewportSize = { width: 1000, height: 800 };
    const visible = viewportWorldRect(viewportSize, world);

    expect(visible).toEqual({
      x: 0,
      y: 0,
      w: 2000,
      h: 1600,
    });
  });

  it("converts world rect to screen coordinates with origin offset", () => {
    const world: WorldTransform = { panX: 50, panY: 50, zoom: 1.5 };
    const worldRect: Rect = { x: 10, y: 20, w: 100, h: 200 };
    const origin = { x: 10, y: 20 };

    const screenRect = worldRectToScreen(worldRect, world, origin);
    // x = 10 + 50 + 10 * 1.5 = 75
    // y = 20 + 50 + 20 * 1.5 = 100
    // w = 100 * 1.5 = 150
    // h = 200 * 1.5 = 300
    expect(screenRect).toEqual({
      x: 75,
      y: 100,
      w: 150,
      h: 300,
    });
  });

  it("calculates rect center and bounding box correctly", () => {
    const r1: Rect = { x: 0, y: 0, w: 100, h: 50 };
    const r2: Rect = { x: 200, y: 100, w: 50, h: 50 };

    expect(rectCenter(r1)).toEqual({ x: 50, y: 25 });
    expect(bboxOf([r1, r2])).toEqual({
      x: 0,
      y: 0,
      w: 250,
      h: 150,
    });
    expect(bboxOf([])).toBeNull();
  });

  it("computes quadratic control point for bezier arcs", () => {
    const p1 = { x: 0, y: 0 };
    const p2 = { x: 100, y: 0 };
    const cp = quadraticControlPoint(p1, p2, 0.2);

    expect(cp.x).toBe(50);
    expect(cp.y).toBe(20);
  });

  it("clips line from center to rect boundary", () => {
    const rect: Rect = { x: 100, y: 100, w: 100, h: 100 };
    const center = rectCenter(rect); // (150, 150)
    const target = { x: 300, y: 150 }; // going right

    const clipped = clipLineToRect(center, target, rect);
    expect(clipped.x).toBe(200);
    expect(clipped.y).toBe(150);
  });

  it("generates slots for initial cards, centered slots, and point slots", () => {
    const cSlot = cascadeSlot(0);
    expect(cSlot.x).toBeGreaterThanOrEqual(70); // D1 protection gutter

    const visible: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
    const centSlot = centeredSlot(visible, 0);
    expect(centSlot.w).toBe(860);
    expect(centSlot.h).toBe(660);

    const ptSlot = pointSlot({ x: 500, y: 500 });
    expect(ptSlot.x).toBe(500 - 860 / 2);
    expect(ptSlot.y).toBe(500 - 660 / 2);
  });

  it("computes overlap area between rects, 0 when they don't overlap", () => {
    const r1: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const r2: Rect = { x: 50, y: 50, w: 100, h: 100 };
    const r3: Rect = { x: 200, y: 200, w: 50, h: 50 };

    expect(overlapArea(r1, r2)).toBe(50 * 50);
    expect(overlapArea(r1, r3)).toBe(0);
  });

  it("centeredSlot dodges an existing rect it would otherwise collide with", () => {
    const visible: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
    const base = centeredSlot(visible, 0);
    // Sem `existingRects`, o slot 0 é sempre o mesmo (determinístico) —
    // usa esse próprio resultado como o obstáculo a evitar.
    const dodged = centeredSlot(visible, 0, [base]);

    expect(dodged.w).toBe(base.w);
    expect(dodged.h).toBe(base.h);
    expect(rectsOverlap(dodged, base)).toBe(false);
  });

  it("centeredSlot keeps the plain slot when nothing collides", () => {
    const visible: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
    const somewhereElse: Rect = { x: 900, y: 900, w: 50, h: 50 };

    expect(centeredSlot(visible, 0, [somewhereElse])).toEqual(centeredSlot(visible, 0));
  });

  it("performs hit testing by z-order", () => {
    const itemA: BoardItem = { id: "a", kind: "terminal", rect: { x: 0, y: 0, w: 100, h: 100 } };
    const itemB: BoardItem = { id: "b", kind: "terminal", rect: { x: 50, y: 50, w: 100, h: 100 } };
    const order = ["a", "b"];

    // Point in overlap region (60, 60): topmost item 'b' should win
    const hit = hitTest([itemA, itemB], { x: 60, y: 60 }, order);
    expect(hit?.id).toBe("b");

    // Point only in 'a' (20, 20)
    const hitOnlyA = hitTest([itemA, itemB], { x: 20, y: 20 }, order);
    expect(hitOnlyA?.id).toBe("a");

    // Point outside all
    const hitNone = hitTest([itemA, itemB], { x: 500, y: 500 }, order);
    expect(hitNone).toBeNull();
  });
});
