import { describe, expect, it } from "vitest";
import {
  applyAllowlist,
  colorDeltaE,
  comparePairStyles,
  compareStyleProp,
  formatDiffTable,
  isApprovedDiff,
  parseCssColor,
  parseCssPx,
  validateParitySpec,
} from "../../scripts/verify/prototype-parity-compare.mjs";

describe("parseCssPx", () => {
  it("reads px lengths", () => {
    expect(parseCssPx("13.5px")).toBe(13.5);
    expect(parseCssPx("1280px")).toBe(1280);
  });

  it("rejects non-comparable values", () => {
    expect(parseCssPx("auto")).toBeNull();
    expect(parseCssPx("50%")).toBeNull();
  });
});

describe("parseCssColor / colorDeltaE", () => {
  it("parses hex and rgb", () => {
    expect(parseCssColor("#e8eaf0")).toEqual({ r: 232, g: 234, b: 240, a: 1 });
    expect(parseCssColor("rgb(232, 234, 240)")).toEqual({ r: 232, g: 234, b: 240, a: 1 });
  });

  it("ΔE is ~0 for identical colors and small for near matches", () => {
    expect(colorDeltaE("#4a5fe0", "rgb(74, 95, 224)")).toBeLessThan(0.5);
    expect(colorDeltaE("#000000", "#ffffff")!).toBeGreaterThan(50);
  });
});

describe("compareStyleProp — V7 shell regression", () => {
  it("reproves the old 480px shell against the 1280px prototype", () => {
    const diff = compareStyleProp("width", "1280px", "480px", { lengthPx: 1 });
    expect(diff).not.toBeNull();
    expect(diff?.kind).toBe("length");
    expect(diff?.delta).toBe(800);
  });

  it("accepts the current shell within 1px", () => {
    expect(compareStyleProp("width", "1280px", "1280px")).toBeNull();
    expect(compareStyleProp("width", "1280px", "1279.4px", { lengthPx: 1 })).toBeNull();
  });

  it("accepts colors within small ΔE", () => {
    expect(compareStyleProp("color", "#e8eaf0", "rgb(232, 234, 240)")).toBeNull();
    expect(compareStyleProp("background-color", "#0b0d12", "rgb(11, 13, 18)")).toBeNull();
  });

  it("flags font-size drift beyond 1px", () => {
    const diff = compareStyleProp("font-size", "13.5px", "16px");
    expect(diff?.delta).toBe(2.5);
  });
});

describe("allowlist — owner-approved only", () => {
  const diff = {
    pairId: "shell",
    prop: "width",
    proto: "1280px",
    impl: "940px",
    kind: "length" as const,
    delta: 340,
  };

  it("rejects unsigned allowlist entries", () => {
    expect(
      isApprovedDiff(diff, [{ pairId: "shell", prop: "width", reason: "temporary" }]),
    ).toBe(false);
  });

  it("accepts entries with approvedBy + date", () => {
    expect(
      isApprovedDiff(diff, [
        {
          pairId: "shell",
          prop: "width",
          proto: "1280px",
          impl: "940px",
          approvedBy: "owner",
          date: "2026-10-09",
          reason: "min(1280, 96vw) under test viewport",
        },
      ]),
    ).toBe(true);
  });

  it("applyAllowlist keeps unapproved diffs as failing", () => {
    const { failing, approved } = applyAllowlist(
      [diff, { pairId: "title", prop: "font-size", proto: "18px", impl: "16px" }],
      [
        {
          pairId: "shell",
          prop: "width",
          proto: "1280px",
          impl: "940px",
          approvedBy: "owner",
          date: "2026-10-09",
        },
      ],
    );
    expect(approved).toHaveLength(1);
    expect(failing).toHaveLength(1);
    expect(failing[0].pairId).toBe("title");
  });
});

describe("comparePairStyles + validateParitySpec", () => {
  it("aggregates prop diffs for one pair", () => {
    const { diffs } = comparePairStyles(
      "shell",
      { width: "1280px", height: "820px", "border-radius": "16px" },
      { width: "480px", height: "820px", "border-radius": "16px" },
      ["width", "height", "border-radius"],
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].prop).toBe("width");
  });

  it("validateParitySpec requires viewport and signed allowlist fields", () => {
    expect(() => validateParitySpec({ id: "x", pairs: [] })).toThrow(/viewport/);
    expect(() =>
      validateParitySpec({
        id: "v7",
        viewport: { width: 1440, height: 900 },
        pairs: [{ id: "shell", proto: "[role=dialog]", impl: "[data-settings-modal]" }],
        approvedDiffs: [{ pairId: "shell", prop: "width" }],
      }),
    ).toThrow(/approvedBy/);
  });

  it("formatDiffTable renders markdown rows", () => {
    const md = formatDiffTable([
      { pairId: "shell", prop: "width", proto: "1280px", impl: "480px", delta: 800 },
    ]);
    expect(md).toContain("| shell | width | 1280px | 480px | 800.00 |");
  });
});
