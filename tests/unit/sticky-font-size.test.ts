import { describe, expect, it } from "vitest";
import {
  STICKY_FONT_SIZE_DEFAULT,
  STICKY_FONT_SIZE_MAX,
  STICKY_FONT_SIZE_MIN,
  STICKY_FONT_SIZE_STEP,
  clampStickyFontSize,
  parseStickyFontSize,
} from "../../src/renderer/src/card-types";

describe("clampStickyFontSize", () => {
  it("keeps an already-aligned size", () => {
    expect(clampStickyFontSize(14)).toBe(14);
    expect(clampStickyFontSize(STICKY_FONT_SIZE_MIN)).toBe(STICKY_FONT_SIZE_MIN);
    expect(clampStickyFontSize(STICKY_FONT_SIZE_MAX)).toBe(STICKY_FONT_SIZE_MAX);
  });

  it("snaps to the discrete 2px step", () => {
    expect(clampStickyFontSize(15)).toBe(16);
    expect(clampStickyFontSize(13)).toBe(14);
  });

  it("clamps outside the range", () => {
    expect(clampStickyFontSize(STICKY_FONT_SIZE_MIN - STICKY_FONT_SIZE_STEP)).toBe(STICKY_FONT_SIZE_MIN);
    expect(clampStickyFontSize(STICKY_FONT_SIZE_MAX + STICKY_FONT_SIZE_STEP)).toBe(STICKY_FONT_SIZE_MAX);
  });

  it("non-finite input becomes the default, not NaN", () => {
    expect(clampStickyFontSize(Number.NaN)).toBe(STICKY_FONT_SIZE_DEFAULT);
    expect(clampStickyFontSize(Number.POSITIVE_INFINITY)).toBe(STICKY_FONT_SIZE_DEFAULT);
  });
});

describe("parseStickyFontSize", () => {
  it("legacy null/empty system_prompt restores the default (pre-fontSize rows)", () => {
    expect(parseStickyFontSize(null)).toBe(STICKY_FONT_SIZE_DEFAULT);
    expect(parseStickyFontSize(undefined)).toBe(STICKY_FONT_SIZE_DEFAULT);
    expect(parseStickyFontSize("")).toBe(STICKY_FONT_SIZE_DEFAULT);
  });

  it("reads the decimal string toRow writes", () => {
    expect(parseStickyFontSize("16")).toBe(16);
    expect(parseStickyFontSize("10")).toBe(10);
    expect(parseStickyFontSize("28")).toBe(28);
  });

  it("garbage in a reused column does not crash the board load", () => {
    expect(parseStickyFontSize("nope")).toBe(STICKY_FONT_SIZE_DEFAULT);
    expect(parseStickyFontSize("1e3")).toBe(STICKY_FONT_SIZE_MAX);
  });
});
