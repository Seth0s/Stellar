import { describe, expect, it } from "vitest";
import {
  abbreviateHome,
  filterSessions,
  pickContinueBoard,
  recentBadgeId,
  shouldShowFirstRun,
  sortGroupsByName,
} from "../../src/renderer/src/home-decisions";

describe("shouldShowFirstRun", () => {
  it("shows for a fresh profile with no account", () => {
    expect(shouldShowFirstRun({ decided: false, boardCount: 0, cloud: "logged-out" })).toBe(true);
  });

  it("does not show once the choice was made", () => {
    expect(shouldShowFirstRun({ decided: true, boardCount: 0, cloud: "logged-out" })).toBe(false);
  });

  it("does not show when sessions already exist", () => {
    expect(shouldShowFirstRun({ decided: false, boardCount: 2, cloud: "logged-out" })).toBe(false);
  });

  it("does not show for a signed-in account", () => {
    expect(shouldShowFirstRun({ decided: false, boardCount: 0, cloud: "logged-in" })).toBe(false);
  });

  it("does not flash before the account state is known", () => {
    expect(shouldShowFirstRun({ decided: false, boardCount: 0, cloud: null })).toBe(false);
  });

  it("still shows while a login is pending", () => {
    expect(shouldShowFirstRun({ decided: false, boardCount: 0, cloud: "pending" })).toBe(true);
  });
});

describe("pickContinueBoard", () => {
  it("returns null with no sessions", () => {
    expect(pickContinueBoard([])).toBeNull();
  });

  it("returns the only session", () => {
    const one = { id: "a", last_accessed_at: 10 };
    expect(pickContinueBoard([one])).toBe(one);
  });

  it("returns the most recently opened session", () => {
    const boards = [
      { id: "a", last_accessed_at: 10 },
      { id: "b", last_accessed_at: 30 },
      { id: "c", last_accessed_at: 20 },
    ];
    expect(pickContinueBoard(boards)?.id).toBe("b");
  });

  it("keeps the first when the timestamps tie", () => {
    const boards = [
      { id: "a", last_accessed_at: 10 },
      { id: "b", last_accessed_at: 10 },
    ];
    expect(pickContinueBoard(boards)?.id).toBe("a");
  });

  it("treats a null last access as the oldest", () => {
    const boards = [
      { id: "never", last_accessed_at: null },
      { id: "opened", last_accessed_at: 5 },
    ];
    expect(pickContinueBoard(boards)?.id).toBe("opened");
  });
});

describe("recentBadgeId", () => {
  it("has no badge with a single session", () => {
    expect(recentBadgeId([{ id: "a", last_accessed_at: 10 }])).toBeNull();
  });

  it("badges the most recent of several", () => {
    const boards = [
      { id: "a", last_accessed_at: 10 },
      { id: "b", last_accessed_at: 40 },
    ];
    expect(recentBadgeId(boards)).toBe("b");
  });
});

describe("filterSessions", () => {
  const boards = [
    { name: "Maestro", project: "Projects", cwd: "/home/lucas/Workplace/Projects" },
    { name: "Site", project: "StellarPage", cwd: "/home/lucas/Workplace/StellarPage" },
  ];

  it("returns every session for an empty query", () => {
    expect(filterSessions(boards, "  ")).toHaveLength(2);
  });

  it("matches the name, case-insensitively", () => {
    expect(filterSessions(boards, "maestro")).toEqual([boards[0]]);
  });

  it("matches the project label", () => {
    expect(filterSessions(boards, "stellarpage")).toEqual([boards[1]]);
  });

  it("matches the folder path", () => {
    expect(filterSessions(boards, "workplace/projects")).toEqual([boards[0]]);
  });

  it("returns nothing when there is no match", () => {
    expect(filterSessions(boards, "zzz")).toEqual([]);
  });
});

describe("sortGroupsByName", () => {
  it("orders groups by label", () => {
    const groups: [string, number[]][] = [
      ["zeta", [1]],
      ["alpha", [2]],
    ];
    expect(sortGroupsByName(groups).map((g) => g[0])).toEqual(["alpha", "zeta"]);
  });
});

describe("abbreviateHome", () => {
  const home = "/home/lucas";

  it("collapses the home directory itself to ~", () => {
    expect(abbreviateHome("/home/lucas", home)).toBe("~");
  });

  it("replaces a home prefix with ~", () => {
    expect(abbreviateHome("/home/lucas/Workplace/Projects", home)).toBe("~/Workplace/Projects");
  });

  it("leaves a path outside the home untouched", () => {
    expect(abbreviateHome("/etc/stellar", home)).toBe("/etc/stellar");
  });

  it("does not treat a sibling prefix as the home", () => {
    expect(abbreviateHome("/home/lucasx/work", home)).toBe("/home/lucasx/work");
  });
});
