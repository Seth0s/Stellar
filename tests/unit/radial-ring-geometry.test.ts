import { describe, it, expect } from "vitest";
import {
  INNER_RADIUS,
  OUTER_RADIUS,
  PROVIDER_RADIUS,
  TOOL_ITEM_SIZE,
  SPAWN_ITEM_SIZE,
  PROVIDER_ITEM_SIZE,
  EDGE_MARGIN,
  polarOffset,
  toolAngleDeg,
  spawnAngleDeg,
  providerAngleDeg,
  menuExtentRadius,
  clampOpenPoint,
  resolveRingGeometry,
} from "../../src/renderer/src/radial-ring-geometry";

describe("polarOffset — prototype degrees (0° = top)", () => {
  it("places 0° straight up", () => {
    const p = polarOffset(100, 0);
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(-100, 10);
  });

  it("places 90° to the right", () => {
    const p = polarOffset(100, 90);
    expect(p.x).toBeCloseTo(100, 10);
    expect(p.y).toBeCloseTo(0, 10);
  });
});

describe("angle helpers", () => {
  it("tools sit at 45 + i*90", () => {
    expect(toolAngleDeg(0)).toBe(45);
    expect(toolAngleDeg(1)).toBe(135);
    expect(toolAngleDeg(3)).toBe(315);
  });

  it("spawns sit at i*45", () => {
    expect(spawnAngleDeg(0)).toBe(0);
    expect(spawnAngleDeg(7)).toBe(315);
  });

  it("five providers sit on −40 … +40 in steps of 20", () => {
    expect(providerAngleDeg(0, 5)).toBe(-40);
    expect(providerAngleDeg(2, 5)).toBe(0);
    expect(providerAngleDeg(4, 5)).toBe(40);
  });

  it("never walks past +40° when there are more than five providers", () => {
    expect(providerAngleDeg(6, 7)).toBe(40);
    expect(providerAngleDeg(0, 7)).toBe(-40);
  });
});

describe("menuExtentRadius", () => {
  it("uses the spawn ring when the provider arc is closed", () => {
    expect(menuExtentRadius(false)).toBe(OUTER_RADIUS + SPAWN_ITEM_SIZE / 2);
  });

  it("uses the provider arc when open", () => {
    expect(menuExtentRadius(true)).toBe(PROVIDER_RADIUS + PROVIDER_ITEM_SIZE / 2);
  });
});

describe("clampOpenPoint", () => {
  it("leaves a comfortable point untouched", () => {
    const extent = menuExtentRadius(false);
    const p = clampOpenPoint(960, 540, extent, 1920, 1080);
    expect(p).toEqual({ x: 960, y: 540 });
  });

  it("pulls inward near an edge", () => {
    const extent = menuExtentRadius(false);
    const margin = extent + EDGE_MARGIN;
    const p = clampOpenPoint(10, 540, extent, 1920, 1080);
    expect(p.x).toBe(margin);
    expect(p.y).toBe(540);
  });
});

describe("resolveRingGeometry", () => {
  it("keeps prototype radii and node sizes", () => {
    const g = resolveRingGeometry(720, 450, 1440, 900, false);
    expect(g.x).toBe(720);
    expect(g.y).toBe(450);
    expect(g.innerRadius).toBe(INNER_RADIUS);
    expect(g.outerRadius).toBe(OUTER_RADIUS);
    expect(g.providerRadius).toBe(PROVIDER_RADIUS);
    expect(g.toolSize).toBe(TOOL_ITEM_SIZE);
    expect(g.spawnSize).toBe(SPAWN_ITEM_SIZE);
    expect(g.providerSize).toBe(PROVIDER_ITEM_SIZE);
  });

  it("clamps farther when the provider arc is open", () => {
    const closed = resolveRingGeometry(10, 450, 1440, 900, false);
    const open = resolveRingGeometry(10, 450, 1440, 900, true);
    expect(open.x).toBeGreaterThan(closed.x);
  });
});
