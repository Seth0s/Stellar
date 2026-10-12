import { describe, expect, it } from "vitest";
import {
  EDGE_POINTER_PX,
  EDGE_SWIPE_MIN_PX,
  EDGE_TOUCH_PX,
  RAIL_HIDDEN_KEY,
  isEdgeSwipe,
  isInRevealZone,
  isRailVisible,
  readRailHidden,
  shouldAutoHide,
  writeRailHidden,
} from "../../src/renderer/src/rail-visibility-decision";

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("rail hidden preference", () => {
  it("defaults to visible", () => {
    expect(readRailHidden(memoryStore())).toBe(false);
    expect(readRailHidden(null)).toBe(false);
  });

  it("round-trips through storage", () => {
    const store = memoryStore();
    writeRailHidden(store, true);
    expect(store.data[RAIL_HIDDEN_KEY]).toBe("1");
    expect(readRailHidden(store)).toBe(true);
    writeRailHidden(store, false);
    expect(readRailHidden(store)).toBe(false);
  });

  it("survives a store that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readRailHidden(broken)).toBe(false);
    expect(() => writeRailHidden(broken, true)).not.toThrow();
  });
});

describe("reveal zone", () => {
  it("uses 12 px for a pointer and 16 px for touch", () => {
    expect(isInRevealZone("mouse", EDGE_POINTER_PX)).toBe(true);
    expect(isInRevealZone("mouse", EDGE_POINTER_PX + 1)).toBe(false);
    expect(isInRevealZone("pen", 5)).toBe(true);
    expect(isInRevealZone("touch", EDGE_TOUCH_PX)).toBe(true);
    expect(isInRevealZone("touch", EDGE_TOUCH_PX + 1)).toBe(false);
  });

  it("ignores a position outside the window", () => {
    expect(isInRevealZone("mouse", -1)).toBe(false);
  });
});

describe("edge swipe", () => {
  it("needs a start in the band and enough travel to the right", () => {
    expect(isEdgeSwipe(4, 4 + EDGE_SWIPE_MIN_PX)).toBe(true);
    expect(isEdgeSwipe(4, 4 + EDGE_SWIPE_MIN_PX - 1)).toBe(false);
    expect(isEdgeSwipe(EDGE_TOUCH_PX + 2, 200)).toBe(false);
    expect(isEdgeSwipe(4, -20)).toBe(false);
  });
});

describe("auto hide", () => {
  const base = { hidden: true, revealed: true, panelOpen: false, pointerInside: false };

  it("hides a revealed rail once nothing holds it", () => {
    expect(shouldAutoHide(base)).toBe(true);
  });

  it("keeps it while the pointer is over it or a panel is open", () => {
    expect(shouldAutoHide({ ...base, pointerInside: true })).toBe(false);
    expect(shouldAutoHide({ ...base, panelOpen: true })).toBe(false);
  });

  it("never auto-hides a rail the user left visible", () => {
    expect(shouldAutoHide({ ...base, hidden: false })).toBe(false);
  });
});

describe("visibility", () => {
  it("shows the strip unless hidden and not revealed", () => {
    expect(isRailVisible(false, false)).toBe(true);
    expect(isRailVisible(true, false)).toBe(false);
    expect(isRailVisible(true, true)).toBe(true);
  });
});
