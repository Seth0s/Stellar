import { describe, expect, it } from "vitest";
import { decideBrowserOpen, decideBrowserReuse } from "../../src/browser-open-policy";

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

describe("decideBrowserOpen — deterministic target selection (P1 open_url bug)", () => {
  const cards = [
    { id: "1", kind: "terminal", ownerCardId: null },
    { id: "10", kind: "browser", ownerCardId: "1" }, // reference prototype (older)
    { id: "11", kind: "browser", ownerCardId: "1" }, // the real target (newer)
    { id: "12", kind: "browser", ownerCardId: "2" }, // someone else's browser
    { id: "13", kind: "browser", ownerCardId: null }, // opened by a human
  ];

  it("honors an explicit cardId that is the caller's own browser", () => {
    expect(decideBrowserOpen("1", cards, { targetCardId: "10" })).toEqual({ action: "reuse", cardId: "10" });
    expect(decideBrowserOpen("1", cards, { targetCardId: "11" })).toEqual({ action: "reuse", cardId: "11" });
  });

  it("refuses an explicit cardId that does not exist instead of navigating another", () => {
    const d = decideBrowserOpen("1", cards, { targetCardId: "999" });
    expect(d.action).toBe("refuse");
    expect(d.action === "refuse" && d.error).toContain("999");
  });

  it("refuses an explicit cardId that is not a browser card", () => {
    const d = decideBrowserOpen("1", cards, { targetCardId: "1" });
    expect(d.action).toBe("refuse");
    expect(d.action === "refuse" && d.error).toContain("not a browser");
  });

  it("refuses a browser owned by someone else (and one opened by a human)", () => {
    const foreign = decideBrowserOpen("1", cards, { targetCardId: "12" });
    expect(foreign.action).toBe("refuse");
    expect(foreign.action === "refuse" && foreign.error).toContain("not to you");

    const humanOwned = decideBrowserOpen("1", cards, { targetCardId: "13" });
    expect(humanOwned.action).toBe("refuse");
  });

  it("refuses a contradictory cardId + reuse:false", () => {
    const d = decideBrowserOpen("1", cards, { targetCardId: "10", reuse: false });
    expect(d.action).toBe("refuse");
  });

  it("with no target, reuses the MOST RECENTLY FOCUSED owned browser (z-order), not the first inserted", () => {
    // id 10 was raised to the top after id 11 — the order array is z-order.
    expect(decideBrowserOpen("1", cards, { order: ["1", "11", "10"] })).toEqual({ action: "reuse", cardId: "10" });
    expect(decideBrowserOpen("1", cards, { order: ["1", "10", "11"] })).toEqual({ action: "reuse", cardId: "11" });
  });

  it("falls back to the most recently CREATED owned browser when order is absent", () => {
    expect(decideBrowserOpen("1", cards)).toEqual({ action: "reuse", cardId: "11" });
  });

  it("opens a new card for a human or when the agent owns no browser", () => {
    expect(decideBrowserOpen(null, cards)).toEqual({ action: "new" });
    expect(decideBrowserOpen("3", cards)).toEqual({ action: "new" });
    expect(decideBrowserOpen("1", cards, { reuse: false })).toEqual({ action: "new" });
  });
});
