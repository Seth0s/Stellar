import { describe, expect, it } from "vitest";
import {
  effectiveScope,
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

  it("local and account never share a content section; stats is the only common one", () => {
    const local = scopeNavSections("local");
    const account = scopeNavSections("account");
    expect(local).toEqual(["sessions", "stats"]);
    expect(account).toEqual(["inbox", "workhome", "team", "stats"]);
    expect(local.filter((s) => account.includes(s))).toEqual(["stats"]);
  });

  it("each scope lands on a section that belongs to it", () => {
    for (const scope of ["local", "account"] as const) {
      expect(sectionAllowedInScope(scopeLanding(scope), scope)).toBe(true);
    }
    expect(scopeLanding("local")).toBe("sessions");
    expect(scopeLanding("account")).toBe("workhome");
  });

  it("the account page and cloud sections are not reachable from the local scope", () => {
    expect(sectionAllowedInScope("account", "local")).toBe(false);
    expect(sectionAllowedInScope("team", "local")).toBe(false);
    expect(sectionAllowedInScope("sessions", "account")).toBe(false);
    expect(sectionAllowedInScope("account", "account")).toBe(true);
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
