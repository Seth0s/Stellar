import { describe, expect, it } from "vitest";
import {
  decideBrowserPartition,
  decideDisplayMode,
} from "../../src/main/browser-profile-decision";

describe("decideBrowserPartition", () => {
  it("defaults to ephemeral (no persist: prefix)", () => {
    const d = decideBrowserPartition("42", false);
    expect(d).toEqual({ action: "accept", kind: "ephemeral", partition: "stellar-browser-42" });
  });

  it("persistent uses persist: prefix scoped to the card id", () => {
    const d = decideBrowserPartition("99", true);
    expect(d).toEqual({
      action: "accept",
      kind: "persistent",
      partition: "persist:stellar-browser-99",
    });
  });

  it("refuses empty or path-like ids", () => {
    expect(decideBrowserPartition("", true).action).toBe("refuse");
    expect(decideBrowserPartition("a/b", true).action).toBe("refuse");
    expect(decideBrowserPartition("a:b", true).action).toBe("refuse");
  });
});

describe("decideDisplayMode", () => {
  it("accepts standalone and browser", () => {
    expect(decideDisplayMode({ mode: "standalone" })).toEqual({ action: "apply", mode: "standalone" });
    expect(decideDisplayMode({ mode: "browser" })).toEqual({ action: "apply", mode: "browser" });
  });

  it("refuses unknown modes", () => {
    expect(decideDisplayMode({ mode: "fullscreen" }).action).toBe("refuse");
    expect(decideDisplayMode({}).action).toBe("refuse");
  });
});
