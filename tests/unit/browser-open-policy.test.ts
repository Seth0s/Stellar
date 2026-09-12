import { describe, expect, it } from "vitest";
import { decideBrowserReuse } from "../../src/browser-open-policy";

describe("decideBrowserReuse (DESIGN-BACKLOG.md §2.0 item 5)", () => {
  it("never reuses for a human (null owner), even if reuse:true is passed", () => {
    expect(decideBrowserReuse(null)).toBe(false);
    expect(decideBrowserReuse(null, true)).toBe(false);
    expect(decideBrowserReuse(null, false)).toBe(false);
  });

  it("defaults to reuse for an agent owner (anti-clutter)", () => {
    expect(decideBrowserReuse("42")).toBe(true);
    expect(decideBrowserReuse("42", true)).toBe(true);
  });

  it("opens a new card when the agent passes reuse:false", () => {
    expect(decideBrowserReuse("42", false)).toBe(false);
  });
});
