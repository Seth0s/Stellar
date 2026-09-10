import { describe, it, expect } from "vitest";
import {
  BASE_RADIUS,
  BASE_ITEM_SIZE,
  EDGE_MARGIN,
  idealRadiusFor,
  clampOpenPoint,
  maxRadiusFrom,
  itemSizeFor,
  resolveRingGeometry,
} from "../../src/renderer/src/radial-ring-geometry";

// The real invariant `itemSizeFor` has to hold, for ANY item count and
// ANY radius: an item can never be bigger than the slice of ring
// circumference it was actually given. This is what review round 4
// found broken — the previous test only asserted
// `size >= ITEM_SIZE_FLOOR`, which is just `itemSizeFor`'s own
// `Math.max(ITEM_SIZE_FLOOR, ...)` restated; it could never fail even
// when items visibly overlapped. Every test below that touches sizing
// checks THIS instead, not a restatement of the implementation.
function arcPerItem(itemCount: number, radius: number): number {
  return (Math.PI * 2 * radius) / itemCount;
}

describe("idealRadiusFor", () => {
  it("never goes below BASE_RADIUS for a small item count", () => {
    expect(idealRadiusFor(1)).toBe(BASE_RADIUS);
    expect(idealRadiusFor(7)).toBe(BASE_RADIUS); // today's real provider submenu count (6 + "voltar")
    expect(idealRadiusFor(11)).toBe(BASE_RADIUS); // today's real root ring count
  });

  it("grows with item count once the count needs more room than BASE_RADIUS gives", () => {
    const r16 = idealRadiusFor(16);
    const r32 = idealRadiusFor(32);
    const r64 = idealRadiusFor(64);
    expect(r16).toBeGreaterThanOrEqual(BASE_RADIUS);
    expect(r32).toBeGreaterThan(r16);
    expect(r64).toBeGreaterThan(r32);
  });

  it("is monotonically non-decreasing as item count grows", () => {
    let prev = idealRadiusFor(1);
    for (let n = 2; n <= 100; n++) {
      const cur = idealRadiusFor(n);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("at the ideal radius, BASE_ITEM_SIZE items always fit their arc with room to spare", () => {
    // This is the property idealRadiusFor exists to guarantee: for ANY
    // item count, the arc available per item at the ideal radius is
    // enough to hold a full BASE_ITEM_SIZE item (plus its gap).
    for (const n of [1, 2, 7, 11, 16, 32, 64, 100]) {
      expect(arcPerItem(n, idealRadiusFor(n))).toBeGreaterThanOrEqual(BASE_ITEM_SIZE);
    }
  });
});

describe("clampOpenPoint — review round 4: move the CENTER, not the radius", () => {
  it("leaves a comfortably-placed point untouched", () => {
    // Plenty of clearance on every side for a BASE_RADIUS ring.
    const p = clampOpenPoint(960, 540, BASE_RADIUS, 1920, 1080);
    expect(p).toEqual({ x: 960, y: 540 });
  });

  it("pulls the point inward, away from an edge, by exactly enough for the ring to fit", () => {
    // Opened 10px from the left edge — nowhere near enough room for an
    // 88px-radius ring. The clamped x must land exactly at the ring's
    // required margin from that edge.
    const radius = 88;
    const margin = radius + BASE_ITEM_SIZE / 2 + EDGE_MARGIN;
    const p = clampOpenPoint(10, 540, radius, 1920, 1080);
    expect(p.x).toBe(margin);
    expect(p.y).toBe(540); // untouched on the unconstrained axis
  });

  it("pulls inward from either edge on the same axis, whichever is closer", () => {
    const radius = 88;
    const margin = radius + BASE_ITEM_SIZE / 2 + EDGE_MARGIN;
    const nearRight = clampOpenPoint(1910, 540, radius, 1920, 1080);
    expect(nearRight.x).toBe(1920 - margin);
  });

  it("the whole ring (clamped center +/- radius +/- half item) fits inside the viewport, for many open points", () => {
    const radius = idealRadiusFor(11);
    const halfItem = BASE_ITEM_SIZE / 2;
    const viewportWidth = 1440;
    const viewportHeight = 900;
    const openPoints = [
      [0, 0],
      [1440, 900],
      [5, 450],
      [1435, 450],
      [720, 5],
      [720, 895],
      [3, 3],
      [1437, 897],
    ];
    for (const [x, y] of openPoints) {
      const p = clampOpenPoint(x, y, radius, viewportWidth, viewportHeight);
      expect(p.x - radius - halfItem).toBeGreaterThanOrEqual(0);
      expect(p.x + radius + halfItem).toBeLessThanOrEqual(viewportWidth);
      expect(p.y - radius - halfItem).toBeGreaterThanOrEqual(0);
      expect(p.y + radius + halfItem).toBeLessThanOrEqual(viewportHeight);
    }
  });

  it("centers the axis as a best effort when the viewport itself is narrower than the ring needs", () => {
    // A 100px-wide viewport can't fit an 88px-radius ring's margin on
    // either side no matter where the point clamps to — centering is the
    // documented fallback (resolveRingGeometry's radius shrink handles
    // avoiding overlap in this case, not this function).
    const p = clampOpenPoint(10, 540, 88, 100, 1080);
    expect(p.x).toBe(50);
  });
});

describe("maxRadiusFrom", () => {
  it("returns a big radius when there's plenty of clearance", () => {
    expect(maxRadiusFrom(960, 540, 1920, 1080)).toBeGreaterThan(BASE_RADIUS * 4);
  });

  it("matches the nearest edge's clearance, minus half an item and the edge margin", () => {
    const r = maxRadiusFrom(100, 540, 1920, 1080);
    expect(r).toBe(100 - BASE_ITEM_SIZE / 2 - EDGE_MARGIN);
  });

  it("can legitimately return near-0 for a point flush against a corner — no floor here", () => {
    const r = maxRadiusFrom(1, 1, 1920, 1080);
    expect(r).toBeLessThan(5);
    expect(r).toBeGreaterThanOrEqual(0);
  });
});

describe("itemSizeFor — the invariant review round 4 needed asserted for real", () => {
  it("never exceeds the arc actually available per item, for a wide range of counts and radii", () => {
    const counts = [1, 2, 3, 7, 11, 16, 32, 64, 100, 200];
    const radii = [0, 1, 5, 14, 28, 44, 88, 150, 500];
    for (const n of counts) {
      for (const r of radii) {
        const size = itemSizeFor(n, r);
        // The real invariant: an item can never claim more circumference
        // than its own slice of the ring provides.
        expect(size).toBeLessThanOrEqual(arcPerItem(n, r));
      }
    }
  });

  it("stays at BASE_ITEM_SIZE for today's real counts at BASE_RADIUS", () => {
    expect(itemSizeFor(11, BASE_RADIUS)).toBe(BASE_ITEM_SIZE);
    expect(itemSizeFor(7, BASE_RADIUS)).toBe(BASE_ITEM_SIZE);
  });

  it("never exceeds BASE_ITEM_SIZE even at a very generous radius", () => {
    expect(itemSizeFor(3, 500)).toBe(BASE_ITEM_SIZE);
  });

  it("shrinks (never grows past the arc) once the radius is tight for the item count", () => {
    // 11 items on a radius small enough that BASE_ITEM_SIZE would
    // overlap — the exact scenario review round 3's floor got wrong.
    const tightRadius = 28;
    const size = itemSizeFor(11, tightRadius);
    expect(size).toBeLessThan(BASE_ITEM_SIZE);
    expect(size).toBeLessThanOrEqual(arcPerItem(11, tightRadius));
  });
});

describe("resolveRingGeometry — end to end, as RadialMenu.tsx uses it", () => {
  it("today's real counts, plenty of room: point untouched, radius/size unchanged from before this fix", () => {
    const g = resolveRingGeometry(960, 540, 11, 1920, 1080);
    expect(g.x).toBe(960);
    expect(g.y).toBe(540);
    expect(g.radius).toBe(BASE_RADIUS);
    expect(g.itemSize).toBe(BASE_ITEM_SIZE);
  });

  it("menu opened right at a corner of a normal-sized window: point moves, radius/size stay full — no shrinking at all", () => {
    const g = resolveRingGeometry(2, 2, 11, 1920, 1080);
    expect(g.x).toBeGreaterThan(2); // pulled inward from the corner
    expect(g.y).toBeGreaterThan(2);
    expect(g.radius).toBe(idealRadiusFor(11)); // full ideal radius — the point moved, not the size
    expect(g.itemSize).toBe(BASE_ITEM_SIZE); // never had to shrink
  });

  it("a genuinely tiny window: radius and item size both shrink together, never overlapping", () => {
    const g = resolveRingGeometry(50, 40, 11, 100, 80);
    expect(g.radius).toBeLessThan(idealRadiusFor(11));
    // The invariant that matters, checked at the ACTUAL resolved radius —
    // not a floor restated as a lower bound.
    expect(g.itemSize).toBeLessThanOrEqual(arcPerItem(11, g.radius));
  });

  it("holds the no-overlap invariant across a spread of item counts and viewport sizes, including tiny ones", () => {
    const counts = [1, 6, 7, 11, 20];
    const viewports: [number, number][] = [
      [1920, 1080],
      [800, 600],
      [400, 300],
      [150, 150],
      [80, 60],
    ];
    for (const n of counts) {
      for (const [vw, vh] of viewports) {
        const g = resolveRingGeometry(vw / 2, vh / 2, n, vw, vh);
        expect(g.itemSize).toBeLessThanOrEqual(arcPerItem(n, g.radius) + 1e-9);
      }
    }
  });
});
