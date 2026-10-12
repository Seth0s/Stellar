import { describe, expect, it } from "vitest";
import {
  accountProfilesFrom,
  assignBoards,
  effectiveAccountProfile,
  effectiveScope,
  newBoardIds,
  teamSectionVisible,
  partitionBoards,
  pruneAssignments,
  assignmentsFromRows,
  migrateLegacyAssignments,
  planLegacyMigration,
  legacyAssignmentsKey,
  readStoredScope,
  scopeFooterSubKey,
  scopeLanding,
  scopeNavSections,
  scopeStorageKey,
  sectionAllowedInScope,
  writeStoredScope,
} from "../../src/renderer/src/account-scope-decision";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("account scope", () => {
  it("without an account the scope is always local, whatever was stored", () => {
    expect(effectiveScope(false, null)).toBe("local");
    expect(effectiveScope(false, "account")).toBe("local");
  });

  it("with an account: the stored choice, else account", () => {
    expect(effectiveScope(true, null)).toBe("account");
    expect(effectiveScope(true, "local")).toBe("local");
    expect(effectiveScope(true, "account")).toBe("account");
  });

  it("both scopes have Sessões; the account adds inbox and work home; Time only under a team profile", () => {
    expect(scopeNavSections("local")).toEqual(["sessions", "stats"]);
    expect(scopeNavSections("account")).toEqual(["sessions", "inbox", "workhome", "stats"]);
    expect(scopeNavSections("account", { team: true })).toEqual(["sessions", "inbox", "workhome", "team", "stats"]);
    expect(scopeNavSections("local", { team: true })).toEqual(["sessions", "stats"]);
  });

  it("each scope lands on its Sessões", () => {
    for (const scope of ["local", "account"] as const) {
      expect(scopeLanding(scope)).toBe("sessions");
      expect(sectionAllowedInScope(scopeLanding(scope), scope)).toBe(true);
    }
  });

  it("the account page and cloud sections are not reachable from the local scope; Time needs a team profile", () => {
    expect(sectionAllowedInScope("account", "local")).toBe(false);
    expect(sectionAllowedInScope("team", "local")).toBe(false);
    expect(sectionAllowedInScope("inbox", "local")).toBe(false);
    expect(sectionAllowedInScope("sessions", "account")).toBe(true);
    expect(sectionAllowedInScope("account", "account")).toBe(true);
    expect(sectionAllowedInScope("team", "account")).toBe(false);
    expect(sectionAllowedInScope("team", "account", { team: true })).toBe(true);
  });

  it("the footer subtitle follows the scope", () => {
    expect(scopeFooterSubKey("account")).toBe("shell.accountSub");
    expect(scopeFooterSubKey("local")).toBe("shell.accountSub.local");
  });

  it("the choice is stored per profile and survives a round trip; garbage reads as no choice", () => {
    const storage = memoryStorage();
    writeStoredScope(storage, "p1", "local");
    expect(readStoredScope(storage, "p1")).toBe("local");
    expect(readStoredScope(storage, "p2")).toBeNull();
    const dirty = memoryStorage({ [scopeStorageKey("p1")]: "everything" });
    expect(readStoredScope(dirty, "p1")).toBeNull();
    expect(readStoredScope(null, "p1")).toBeNull();
  });

  it("unavailable storage never throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredScope(broken, "p1")).toBeNull();
    expect(() => writeStoredScope(broken, "p1", "account")).not.toThrow();
  });
});

describe("account profiles", () => {
  const raw = [
    { id: "t2", kind: "team", teamId: "tm2", name: "Zeta" },
    { id: "p1", kind: "personal", teamId: null, name: "Pro" },
    { id: "t1", kind: "team", teamId: "tm1", name: "Alfa" },
  ];

  it("lists the personal profile first, then the teams by name", () => {
    expect(accountProfilesFrom(raw).map((p) => p.id)).toEqual(["p1", "t1", "t2"]);
    expect(accountProfilesFrom(raw)[1]).toEqual({ id: "t1", name: "Alfa", kind: "team", teamId: "tm1" });
  });

  it("a team without a profile row still gets an entry (its Time section stays reachable)", () => {
    const list = accountProfilesFrom(
      [{ id: "p1", kind: "personal", teamId: null, name: "Pro" }, { id: "t1", kind: "team", teamId: "tm1", name: "Alfa" }],
      [{ id: "tm1", name: "Alfa" }, { id: "tm9", name: "Orfã" }],
    );
    expect(list.map((p) => p.id)).toEqual(["p1", "t1", "team:tm9"]);
    expect(list[2]).toEqual({ id: "team:tm9", name: "Orfã", kind: "team", teamId: "tm9" });
  });

  it("Time shows under a team profile; under Pro only when the account has no team to switch to", () => {
    const pro = { id: "p1", name: "Pro", kind: "personal", teamId: null } as const;
    const team = { id: "t1", name: "Alfa", kind: "team", teamId: "tm1" } as const;
    expect(teamSectionVisible(team, [pro, team], true)).toBe(true);
    expect(teamSectionVisible(pro, [pro, team], true)).toBe(false); // there is a team to switch to
    expect(teamSectionVisible(pro, [pro], true)).toBe(true); // no team yet: Time is where one is created
    expect(teamSectionVisible(pro, [], false)).toBe(false); // list not known yet: not shown
    expect(teamSectionVisible(null, [], true)).toBe(true);
  });

  it("the profile in view is the stored one while it exists, else the personal one", () => {
    const list = accountProfilesFrom(raw);
    expect(effectiveAccountProfile(list, "t2")?.id).toBe("t2");
    expect(effectiveAccountProfile(list, "gone")?.id).toBe("p1");
    expect(effectiveAccountProfile(list, null)?.id).toBe("p1");
    expect(effectiveAccountProfile([], null)).toBeNull();
  });
});

describe("sessions per account profile", () => {
  const boards = [{ id: "b1" }, { id: "b2" }, { id: "b3" }, { id: "b4" }];
  const assignments = { b2: "p1", b3: "t1", gone: "p1" };

  it("local shows what no account profile owns; each profile shows only its own; they never mix", () => {
    const local = partitionBoards(boards, assignments, { scope: "local" }).map((b) => b.id);
    const pro = partitionBoards(boards, assignments, { scope: "account", accountProfileId: "p1" }).map((b) => b.id);
    const team = partitionBoards(boards, assignments, { scope: "account", accountProfileId: "t1" }).map((b) => b.id);
    expect(local).toEqual(["b1", "b4"]);
    expect(pro).toEqual(["b2"]);
    expect(team).toEqual(["b3"]);
    expect([...local, ...pro, ...team].sort()).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("a fresh account profile has no sessions until some are created or imported", () => {
    expect(partitionBoards(boards, {}, { scope: "account", accountProfileId: "p1" })).toEqual([]);
    expect(partitionBoards(boards, assignments, { scope: "account", accountProfileId: null })).toEqual([]);
  });

  it("importing moves the chosen local sessions into the profile", () => {
    const next = assignBoards(assignments, ["b1"], "p1");
    expect(partitionBoards(boards, next, { scope: "local" }).map((b) => b.id)).toEqual(["b4"]);
    expect(partitionBoards(boards, next, { scope: "account", accountProfileId: "p1" }).map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(assignments).toEqual({ b2: "p1", b3: "t1", gone: "p1" }); // input untouched
  });

  it("finds the session that was just created, and prunes the ones that no longer exist", () => {
    expect(newBoardIds(new Set(["b1", "b2"]), boards)).toEqual(["b3", "b4"]);
    expect(pruneAssignments(assignments, new Set(["b2", "b3"]))).toEqual({ b2: "p1", b3: "t1" });
    const same = { b2: "p1" };
    expect(pruneAssignments(same, new Set(["b2"]))).toBe(same);
  });

  it("the owners come from the database rows: only sessions that belong to an account profile", () => {
    expect(assignmentsFromRows([{ id: "1", account_profile_id: null }, { id: "2", account_profile_id: "p1" }, { id: "3" }, { id: "4", account_profile_id: "" }])).toEqual({ "2": "p1" });
  });

  it("clearing the renderer storage changes nothing: the partition reads the database rows", () => {
    const rows = [{ id: "b1" }, { id: "b2", account_profile_id: "p1" }, { id: "b3", account_profile_id: "t1" }];
    const view = { scope: "account", accountProfileId: "p1" } as const;
    const before = partitionBoards(rows, assignmentsFromRows(rows), view).map((b) => b.id);
    const storage = memoryStorage({ "ac.scope.x": "account", "ac.acctProfile.x": "p1" });
    storage.setItem("ac.scope.x", ""); // wipe what the renderer kept
    const after = partitionBoards(rows, assignmentsFromRows(rows), view).map((b) => b.id);
    expect(after).toEqual(before);
    expect(after).toEqual(["b2"]);
  });
});

describe("one-time move of the old renderer partition into the database", () => {
  function storageWith(raw: string | null) {
    const data = new Map<string, string>();
    if (raw !== null) data.set(legacyAssignmentsKey("p1"), raw);
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      removeItem: (k: string) => void data.delete(k),
    };
  }

  it("groups the old map by owner", () => {
    expect(planLegacyMigration(null)).toEqual({ present: false, groups: [] });
    expect(planLegacyMigration('{"b1":"pro","b2":"pro","b3":"team","b4":7,"b5":""}')).toEqual({
      present: true,
      groups: [{ owner: "pro", ids: ["b1", "b2"] }, { owner: "team", ids: ["b3"] }],
    });
    expect(planLegacyMigration("{bad")).toEqual({ present: true, groups: [] });
    expect(planLegacyMigration("[1]")).toEqual({ present: true, groups: [] });
  });

  it("writes every owner to the database, then clears the old key", async () => {
    const storage = storageWith('{"b1":"pro","b3":"team"}');
    const calls: [string[], string][] = [];
    const res = await migrateLegacyAssignments(storage, "p1", async (ids, owner) => void calls.push([ids, owner]));
    expect(res.moved).toBe(true);
    expect(calls).toEqual([[["b1"], "pro"], [["b3"], "team"]]);
    expect(storage.data.size).toBe(0);
  });

  it("is idempotent: with the key gone there is nothing to do", async () => {
    const storage = storageWith('{"b1":"pro"}');
    const setOwner = async () => undefined;
    expect((await migrateLegacyAssignments(storage, "p1", setOwner)).moved).toBe(true);
    let called = 0;
    expect((await migrateLegacyAssignments(storage, "p1", async () => void called++)).moved).toBe(false);
    expect(called).toBe(0);
  });

  it("a failed database write keeps the key, so the next start tries again", async () => {
    const storage = storageWith('{"b1":"pro"}');
    const res = await migrateLegacyAssignments(storage, "p1", async () => {
      throw new Error("db busy");
    });
    expect(res.moved).toBe(false);
    expect(storage.data.get(legacyAssignmentsKey("p1"))).toBe('{"b1":"pro"}');
  });

  it("an empty or unreadable old key is just removed", async () => {
    for (const raw of ["{}", "{bad"]) {
      const storage = storageWith(raw);
      const res = await migrateLegacyAssignments(storage, "p1", async () => {
        throw new Error("never called");
      });
      expect(res.moved).toBe(false);
      expect(storage.data.size).toBe(0);
    }
  });

  it("unavailable storage never throws", async () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect((await migrateLegacyAssignments(broken, "p1", async () => undefined)).moved).toBe(false);
    expect((await migrateLegacyAssignments(null, "p1", async () => undefined)).moved).toBe(false);
  });
});
