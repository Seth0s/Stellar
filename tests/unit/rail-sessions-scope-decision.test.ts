import { describe, it, expect } from "vitest";
import { sessionsInScope, viewOfBoard } from "../../src/renderer/src/rail-sessions-scope-decision";

const boards = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const rows = [
  { id: "a", account_profile_id: null },
  { id: "b", account_profile_id: "p1" },
  { id: "c", account_profile_id: "p1" },
  { id: "d", account_profile_id: "p2" },
];

describe("rail session list scope", () => {
  it("a local board lists the local sessions only", () => {
    expect(sessionsInScope(boards, rows, "a").map((b) => b.id)).toEqual(["a"]);
  });

  it("an account board lists its owner's sessions only", () => {
    expect(sessionsInScope(boards, rows, "b").map((b) => b.id)).toEqual(["b", "c"]);
    expect(sessionsInScope(boards, rows, "d").map((b) => b.id)).toEqual(["d"]);
  });

  it("lists everything until the owners were read", () => {
    expect(sessionsInScope(boards, null, "b")).toHaveLength(4);
  });

  it("no open board counts as local", () => {
    expect(viewOfBoard({ b: "p1" }, null)).toEqual({ scope: "local" });
  });
});
