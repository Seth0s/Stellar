import { describe, expect, it } from "vitest";
import { decideViewport, VIEWPORT_DIM_MAX, VIEWPORT_DIM_MIN } from "../../src/main/browser-viewport-decision";

describe("decideViewport", () => {
  it("applies width+height with defaults (dsf=1, mobile from width)", () => {
    const d = decideViewport({ width: 375, height: 812 });
    expect(d).toEqual({
      action: "apply",
      width: 375,
      height: 812,
      deviceScaleFactor: 1,
      mobile: true,
    });
  });

  it("desktop width defaults mobile:false", () => {
    const d = decideViewport({ width: 1440, height: 900 });
    expect(d.action).toBe("apply");
    if (d.action === "apply") expect(d.mobile).toBe(false);
  });

  it("honors explicit mobile and deviceScaleFactor", () => {
    const d = decideViewport({ width: 1024, height: 768, mobile: true, deviceScaleFactor: 2 });
    expect(d).toEqual({
      action: "apply",
      width: 1024,
      height: 768,
      deviceScaleFactor: 2,
      mobile: true,
    });
  });

  it("reset alone is accepted; reset+size is refused", () => {
    expect(decideViewport({ reset: true })).toEqual({ action: "reset" });
    expect(decideViewport({ reset: true, width: 375, height: 812 }).action).toBe("refuse");
  });

  it("refuses missing size, out-of-range dims, and bad dsf", () => {
    expect(decideViewport({}).action).toBe("refuse");
    expect(decideViewport({ width: VIEWPORT_DIM_MIN - 1, height: 800 }).action).toBe("refuse");
    expect(decideViewport({ width: 800, height: VIEWPORT_DIM_MAX + 1 }).action).toBe("refuse");
    expect(decideViewport({ width: 800, height: 600, deviceScaleFactor: 0 }).action).toBe("refuse");
    expect(decideViewport({ width: 800, height: 600, deviceScaleFactor: 4 }).action).toBe("refuse");
  });
});
