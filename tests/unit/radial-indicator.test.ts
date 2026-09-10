import { describe, it, expect } from "vitest";
import { computeIndicator, itemAngle, nearestItemIndex } from "../../src/renderer/src/radial-indicator";
import { BASE_RADIUS } from "../../src/renderer/src/radial-ring-geometry";

// Review round 4, achado 3 — this used to hardcode its own `RADIUS = 88`,
// duplicating RadialMenu.tsx's radius constant instead of deriving from
// it; exactly the kind of repeated number that silently drifts out of
// sync when one side changes (board-model.test.ts already broke this way
// once this session, per the same review). RadialMenu.tsx's actual ring
// radius is `resolveRingGeometry`'s output (radial-ring-geometry.ts),
// but for a comfortable viewport with today's real item counts that
// output IS exactly `BASE_RADIUS` (see radial-ring-geometry.test.ts's
// own coverage of that) — so this indicator-geometry test, which only
// cares about the indicator's math and not the ring-sizing/clamping
// logic, uses `BASE_RADIUS` directly rather than re-deriving it.
const RADIUS = BASE_RADIUS;
const RING_BAND = 32;
const COUNT = 11;

describe("itemAngle / nearestItemIndex", () => {
  it("places item 0 straight up (-90deg / -PI/2)", () => {
    expect(itemAngle(0, COUNT)).toBeCloseTo(-Math.PI / 2);
  });

  it("finds the nearest item to an exact item angle", () => {
    const angle = itemAngle(3, COUNT);
    expect(nearestItemIndex(angle, COUNT)).toBe(3);
  });

  it("finds the nearest item to an angle that falls between two items", () => {
    const a = itemAngle(2, COUNT);
    const b = itemAngle(3, COUNT);
    const between = (a + b) / 2 + 0.001; // nudge toward b
    expect(nearestItemIndex(between, COUNT)).toBe(3);
  });

  it("wraps correctly across the -PI/PI seam", () => {
    // Item 0 sits at -PI/2, the last item sits just before it going the
    // other way around the circle — a raw angle just past PI (wrapped
    // negative) should still resolve to whichever item is actually closest.
    const idx = nearestItemIndex(Math.PI - 0.001, COUNT);
    expect(idx).toBe(nearestItemIndex(-Math.PI + 0.001, COUNT));
  });

  // Review achado 1 — the case above (and the old version of this test)
  // deliberately nudges 0.001 rad AWAY from the midpoint specifically to
  // dodge the hard case. These don't dodge it: itemAngle(5.5, 11) is
  // mathematically EXACTLY the midpoint between item 5 and item 6 (===
  // PI/2, asserted below), a genuine tie — not an angle that merely
  // rounds close to one.
  describe("exact tie between two adjacent items (the case that used to depend on float rounding noise)", () => {
    const tieAngle = (itemAngle(5, COUNT) + itemAngle(6, COUNT)) / 2;

    it("is a real, exact mathematical tie — not an approximation", () => {
      // `toBeCloseTo`, not `toBe`: computing the midpoint itself already
      // picks up its own ~1e-16 rounding error (1.5707963267948963 vs.
      // Math.PI / 2's 1.5707963267948966) — the tie is exact in the math,
      // not necessarily bit-for-bit in the float that represents it. That
      // is itself the whole reason `nearestItemIndex` needs an epsilon
      // instead of a raw `<`: even producing the tie angle isn't immune
      // to this noise, so deciding a winner off it definitely isn't either.
      expect(tieAngle).toBeCloseTo(Math.PI / 2, 10);
    });

    it("resolves deterministically to the LOWER index", () => {
      expect(nearestItemIndex(tieAngle, COUNT)).toBe(5);
    });

    it("keeps resolving to the lower index however this exact call is repeated", () => {
      // Not a randomness/flakiness test in the strict sense (this function
      // has no randomness) — a regression guard against ever going back to
      // deciding the winner off a raw `<` over floats, which produced
      // different answers across JS engines for the exact same tieAngle.
      for (let i = 0; i < 20; i++) expect(nearestItemIndex(tieAngle, COUNT)).toBe(5);
    });

    it("does not flip the winner when nudged by less than the float-noise floor either side", () => {
      // Simulates the actual ~1e-16-scale rounding error achado 1 found in
      // `Math.abs(a - b) % twoPi` for angles this close to a tie.
      expect(nearestItemIndex(tieAngle + 1e-13, COUNT)).toBe(5);
      expect(nearestItemIndex(tieAngle - 1e-13, COUNT)).toBe(5);
    });
  });
});

describe("computeIndicator — nothing pointed yet", () => {
  it("is not visible when the cursor has never entered the ring band", () => {
    const result = computeIndicator(5, 5, COUNT, RADIUS, RING_BAND, null);
    expect(result.display.visible).toBe(false);
    expect(result.lastPointedIndex).toBeNull();
  });

  it("is not visible when the cursor sits well outside the band, near the ring's outer edge", () => {
    const result = computeIndicator(RADIUS + RING_BAND + 40, 0, COUNT, RADIUS, RING_BAND, null);
    expect(result.display.visible).toBe(false);
  });
});

describe("computeIndicator — inside the ring band", () => {
  it("follows the raw cursor angle, length capped at the radius", () => {
    // Cursor sitting exactly on the ring, to the right of center.
    const result = computeIndicator(RADIUS, 0, COUNT, RADIUS, RING_BAND, null);
    expect(result.display).toEqual({ visible: true, angle: 0, length: RADIUS });
  });

  it("shortens the line when the cursor is closer than the radius but still in-band", () => {
    const dist = RADIUS - RING_BAND; // inner edge of the band
    const result = computeIndicator(dist, 0, COUNT, RADIUS, RING_BAND, null);
    expect(result.display).toEqual({ visible: true, angle: 0, length: dist });
  });

  it("never exceeds the radius even when the cursor is past the ring (still in-band)", () => {
    const dist = RADIUS + RING_BAND; // outer edge of the band
    const result = computeIndicator(dist, 0, COUNT, RADIUS, RING_BAND, null);
    expect(result.display.visible).toBe(true);
    if (result.display.visible) expect(result.display.length).toBe(RADIUS);
  });

  it("records the nearest item as last-pointed while in-band", () => {
    const angle = itemAngle(4, COUNT);
    const dx = Math.cos(angle) * RADIUS;
    const dy = Math.sin(angle) * RADIUS;
    const result = computeIndicator(dx, dy, COUNT, RADIUS, RING_BAND, null);
    expect(result.lastPointedIndex).toBe(4);
  });
});

describe("computeIndicator — leaving the band (the 'sticks to the last item' rule)", () => {
  it("snaps to the last pointed item's exact angle once the cursor returns to the center", () => {
    const angle = itemAngle(4, COUNT);
    const dx = Math.cos(angle) * RADIUS;
    const dy = Math.sin(angle) * RADIUS;
    const inBand = computeIndicator(dx, dy, COUNT, RADIUS, RING_BAND, null);
    expect(inBand.lastPointedIndex).toBe(4);

    // Cursor moves back to dead center — well outside the band.
    const atCenter = computeIndicator(0, 0, COUNT, RADIUS, RING_BAND, inBand.lastPointedIndex);
    expect(atCenter.display).toEqual({ visible: true, angle: itemAngle(4, COUNT), length: RADIUS });
    // The rule persists across further calls, not just the one right after.
    expect(atCenter.lastPointedIndex).toBe(4);
  });

  it("stays frozen on the last item even if the cursor wanders far past the ring", () => {
    const angle = itemAngle(1, COUNT);
    const dx = Math.cos(angle) * RADIUS;
    const dy = Math.sin(angle) * RADIUS;
    const inBand = computeIndicator(dx, dy, COUNT, RADIUS, RING_BAND, null);

    const farAway = computeIndicator(dx * 5, dy * 5, COUNT, RADIUS, RING_BAND, inBand.lastPointedIndex);
    expect(farAway.display).toEqual({ visible: true, angle: itemAngle(1, COUNT), length: RADIUS });
  });

  it("re-entering the band after freezing resumes live tracking", () => {
    const angle1 = itemAngle(1, COUNT);
    const first = computeIndicator(Math.cos(angle1) * RADIUS, Math.sin(angle1) * RADIUS, COUNT, RADIUS, RING_BAND, null);
    const frozen = computeIndicator(0, 0, COUNT, RADIUS, RING_BAND, first.lastPointedIndex);
    expect(frozen.display).toEqual({ visible: true, angle: angle1, length: RADIUS });

    const angle2 = itemAngle(7, COUNT);
    const resumed = computeIndicator(Math.cos(angle2) * RADIUS, Math.sin(angle2) * RADIUS, COUNT, RADIUS, RING_BAND, frozen.lastPointedIndex);
    expect(resumed.display.visible).toBe(true);
    if (resumed.display.visible) expect(resumed.display.angle).toBeCloseTo(angle2);
    expect(resumed.lastPointedIndex).toBe(7);
  });
});

describe("computeIndicator — dead center (dist = 0, raw angle undefined-ish)", () => {
  // `Math.atan2(0, 0)` is actually well-defined (0, not NaN) in JS/IEEE
  // 754, but it never matters here: dist = 0 is always `RING_BAND` away
  // from any sane `radius`, so the `inBand` branch — the only place that
  // calls `Math.atan2` — is never taken for a cursor sitting exactly on
  // the menu's own center. These two cases are the ones that actually
  // happen: nothing pointed yet, or already had something pointed.
  it("stays invisible at dead center before anything has been pointed at", () => {
    const result = computeIndicator(0, 0, COUNT, RADIUS, RING_BAND, null);
    expect(result.display).toEqual({ visible: false });
    expect(result.lastPointedIndex).toBeNull();
  });

  it("freezes on the last pointed item at dead center, same as anywhere else out of band", () => {
    const result = computeIndicator(0, 0, COUNT, RADIUS, RING_BAND, 4);
    expect(result.display).toEqual({ visible: true, angle: itemAngle(4, COUNT), length: RADIUS });
    expect(result.lastPointedIndex).toBe(4);
  });
});

describe("computeIndicator — fast cursor jump between two pointermove frames (documented limitation)", () => {
  it("only the latest sampled position counts — an item swept over in between is never recorded", () => {
    // Each call is independent, with no memory of the path between one
    // pointermove and the next — see this limitation documented on
    // `computeIndicator`'s own doc comment. A real, fast mouse movement
    // can cross several items' sectors within a single browser-coalesced
    // frame; this simulates exactly that by jumping straight from item 1
    // to item 9 in one call, with nothing in between.
    const angle1 = itemAngle(1, COUNT);
    const first = computeIndicator(Math.cos(angle1) * RADIUS, Math.sin(angle1) * RADIUS, COUNT, RADIUS, RING_BAND, null);
    expect(first.lastPointedIndex).toBe(1);

    const angle9 = itemAngle(9, COUNT);
    const jumped = computeIndicator(Math.cos(angle9) * RADIUS, Math.sin(angle9) * RADIUS, COUNT, RADIUS, RING_BAND, first.lastPointedIndex);
    // Items 2 through 8 were physically "passed over" between these two
    // calls but never appear as `lastPointedIndex` at any point — this
    // assertion documents that gap as accepted behavior, not a bug: only
    // the final sampled position (item 9) is ever recorded.
    expect(jumped.lastPointedIndex).toBe(9);
  });
});
