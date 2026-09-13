import { describe, it, expect } from "vitest";
import { decideIdentifyApply, decideIdentifyCardGate } from "../../src/main/session-identify-apply";

describe("decideIdentifyCardGate", () => {
  it("missing card => unavailable", () => {
    expect(decideIdentifyCardGate(undefined)).toEqual({ status: "unavailable" });
  });

  it("non-terminal => unavailable", () => {
    expect(decideIdentifyCardGate({ kind: "sticky", provider: "claude", resume_id: null })).toEqual({
      status: "unavailable",
    });
  });

  it("resume_id already set => already-set — never a re-identify", () => {
    expect(decideIdentifyCardGate({ kind: "terminal", provider: "claude", resume_id: "abc" })).toEqual({
      status: "already-set",
    });
  });

  it("empty resume on a terminal => proceed (null)", () => {
    expect(decideIdentifyCardGate({ kind: "terminal", provider: "claude", resume_id: null })).toBeNull();
  });
});

describe("decideIdentifyApply", () => {
  it("found + unclaimed => found", () => {
    expect(decideIdentifyApply({ status: "found", ids: ["s1"], source: "src" }, () => false)).toEqual({
      status: "found",
      id: "s1",
      source: "src",
    });
  });

  it("found + already claimed by another card => claimed, do not write", () => {
    expect(decideIdentifyApply({ status: "found", ids: ["taken"], source: "src" }, (id) => id === "taken")).toEqual({
      status: "claimed",
      id: "taken",
      source: "src",
    });
  });

  it("ambiguous stays ambiguous — does not pick", () => {
    expect(
      decideIdentifyApply({ status: "ambiguous", ids: ["a", "b"], source: "src" }, () => false),
    ).toEqual({ status: "ambiguous", ids: ["a", "b"], source: "src" });
  });

  it("none stays none", () => {
    expect(decideIdentifyApply({ status: "none", ids: [], source: "claude" }, () => false)).toEqual({
      status: "none",
      source: "claude",
    });
  });

  it("error keeps the message", () => {
    expect(
      decideIdentifyApply({ status: "error", ids: [], source: "opencode", message: "ENOENT" }, () => false),
    ).toEqual({ status: "error", source: "opencode", message: "ENOENT" });
  });
});
