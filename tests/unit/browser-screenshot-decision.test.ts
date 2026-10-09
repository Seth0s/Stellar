import { describe, expect, it } from "vitest";
import { decideScreenshot } from "../../src/main/browser-screenshot-decision";

describe("decideScreenshot", () => {
  it("defaults to viewport mode", () => {
    expect(decideScreenshot({})).toEqual({
      action: "capture",
      mode: { kind: "viewport" },
      out: null,
      width: null,
    });
  });

  it("accepts fullPage, selector, or ref", () => {
    expect(decideScreenshot({ fullPage: true })).toMatchObject({
      action: "capture",
      mode: { kind: "fullPage" },
    });
    expect(decideScreenshot({ selector: "#hero" })).toMatchObject({
      action: "capture",
      mode: { kind: "element", selector: "#hero" },
    });
    expect(decideScreenshot({ ref: "e3" })).toMatchObject({
      action: "capture",
      mode: { kind: "element", ref: "e3" },
    });
  });

  it("refuses mixed modes and relative out", () => {
    expect(decideScreenshot({ fullPage: true, selector: "#x" }).action).toBe("refuse");
    expect(decideScreenshot({ selector: "#a", ref: "e1" }).action).toBe("refuse");
    expect(decideScreenshot({ out: "relative.png" }).action).toBe("refuse");
  });

  it("accepts absolute out and temporary width", () => {
    const d = decideScreenshot({ out: "/tmp/shot.png", width: 375, fullPage: true });
    expect(d).toEqual({
      action: "capture",
      mode: { kind: "fullPage" },
      out: "/tmp/shot.png",
      width: 375,
    });
  });

  it("refuses out-of-range width", () => {
    expect(decideScreenshot({ width: 50 }).action).toBe("refuse");
    expect(decideScreenshot({ width: 4000 }).action).toBe("refuse");
  });
});
