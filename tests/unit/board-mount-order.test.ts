import { describe, expect, it } from "vitest";
import {
  BOARD_MOUNT_CEILING,
  nextMountReleases,
  orderBoardMount,
  type MountCandidate,
} from "../../src/renderer/src/board-mount-order";

const center = { x: 500, y: 400 };

function card(
  id: string,
  opts: { focused?: boolean; inView?: boolean; x?: number; y?: number } = {},
): MountCandidate {
  return {
    id,
    rect: { x: opts.x ?? 0, y: opts.y ?? 0, w: 200, h: 150 },
    focused: opts.focused ?? false,
    inView: opts.inView ?? false,
  };
}

describe("BOARD_MOUNT_CEILING", () => {
  it("is declared as 2 (docs/PERF.md §17)", () => {
    expect(BOARD_MOUNT_CEILING).toBe(2);
  });
});

describe("orderBoardMount", () => {
  it("puts the focused card first, then visible nearest the center, then off-screen", () => {
    const ordered = orderBoardMount(
      [
        card("far-off", { inView: false, x: 2000, y: 2000 }),
        card("near-off", { inView: false, x: 600, y: 400 }),
        card("far-vis", { inView: true, x: 900, y: 400 }),
        card("near-vis", { inView: true, x: 520, y: 400 }),
        card("focus", { focused: true, inView: true, x: 100, y: 100 }),
      ],
      center,
    );
    expect(ordered).toEqual(["focus", "near-vis", "far-vis", "near-off", "far-off"]);
  });

  it("does not demote a focused card that is off-screen", () => {
    expect(
      orderBoardMount([card("focus", { focused: true, inView: false }), card("vis", { inView: true })], center),
    ).toEqual(["focus", "vis"]);
  });
});

describe("nextMountReleases", () => {
  const ordered = ["a", "b", "c", "d", "e"];

  it("releases up to the ceiling when nothing is in flight", () => {
    expect(nextMountReleases(ordered, new Set(), new Set(), 2)).toEqual(["a", "b"]);
  });

  it("counts released-but-not-ready as in-flight against the ceiling", () => {
    expect(nextMountReleases(ordered, new Set(["a", "b"]), new Set(["a"]), 2)).toEqual(["c"]);
  });

  it("releases nothing while the ceiling is full", () => {
    expect(nextMountReleases(ordered, new Set(["a", "b"]), new Set(), 2)).toEqual([]);
  });

  it("skips already-released ids and continues down the order", () => {
    expect(nextMountReleases(ordered, new Set(["a"]), new Set(["a"]), 2)).toEqual(["b", "c"]);
  });

  it("returns an empty list when every id is already released", () => {
    const all = new Set(ordered);
    expect(nextMountReleases(ordered, all, all, 2)).toEqual([]);
  });
});
