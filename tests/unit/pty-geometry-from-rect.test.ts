import { describe, expect, it } from "vitest";
import { estimatePtyGeometryFromRect } from "../../src/renderer/src/pty-geometry-from-rect";
import { SPAWN_H, SPAWN_W } from "../../src/renderer/src/board-model";

/**
 * Cause 5 (docs/PERF.md §17): a PTY that never fitted stayed at 80×24.
 * Sizing from the card rect at spawn must yield a geometry larger than
 * that default for a normal-sized card — otherwise off-screen terminals
 * keep writing at 80 columns forever.
 */
describe("estimatePtyGeometryFromRect", () => {
  it("matches the documented 860×660 → ~80×24 calibration pair", () => {
    expect(estimatePtyGeometryFromRect({ w: 860, h: 660 })).toEqual({ cols: 80, rows: 24 });
  });

  it("sizes a default spawn card well above the 80×24 fallback", () => {
    const geo = estimatePtyGeometryFromRect({ w: SPAWN_W, h: SPAWN_H });
    expect(geo.cols).toBeGreaterThan(80);
    expect(geo.rows).toBeGreaterThan(24);
  });

  it("never returns below the PTY minimums", () => {
    expect(estimatePtyGeometryFromRect({ w: 1, h: 1 })).toEqual({ cols: 2, rows: 1 });
  });
});
