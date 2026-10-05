import { describe, expect, it } from "vitest";
import {
  decideTerritoryConflict,
  describeSharedCoOwners,
  parseTerritoryEntry,
  resolveTerritoryEntry,
  territoryDeclaresShared,
  territoryEntriesOverlap,
} from "../../src/main/territory-conflict-decision";

/**
 * TERRITORY, per-path mode and the glob × new-file rule. Each case pins a
 * measured scenario: two implementers coordinated on one file, a broad glob
 * that used to hard-block a specific new target, and an orchestrator override
 * that must pass AND be recorded.
 */

const BASE = "/repo";

function conflict(
  mine: string[] | null,
  theirs: string[] | null,
  extra: Partial<Parameters<typeof decideTerritoryConflict>[0]> = {},
) {
  return decideTerritoryConflict({
    taskId: "taskA",
    territory: mine,
    cwd: BASE,
    activeTasks: [{ taskId: "taskB", territory: theirs, cwd: BASE }],
    ...extra,
  });
}

describe("parseTerritoryEntry — mode, note and path", () => {
  it("a bare entry is exclusive with no note", () => {
    expect(parseTerritoryEntry("src/main/index.ts")).toEqual({
      raw: "src/main/index.ts",
      mode: "exclusive",
      note: null,
      path: "src/main/index.ts",
    });
  });

  it("`shared:` carries the mode; the trailing (…) is the note", () => {
    const parsed = parseTerritoryEntry("shared:src/main/index.ts (releia antes de editar)");
    expect(parsed.mode).toBe("shared");
    expect(parsed.note).toBe("releia antes de editar");
    expect(parsed.path).toBe("src/main/index.ts");
  });

  it("resolveTerritoryEntry ignores the `shared:` prefix (the mode is not a path)", () => {
    expect(resolveTerritoryEntry("shared:src/main/index.ts (note)", BASE)?.display).toBe("/repo/src/main/index.ts");
    expect(territoryEntriesOverlap("shared:src/main/index.ts (x)", "src/main/index.ts", BASE, BASE)).toBe(true);
  });

  it("territoryDeclaresShared sees the mode anywhere in the list", () => {
    expect(territoryDeclaresShared(["a.ts", "shared:b.ts (note)"])).toBe(true);
    expect(territoryDeclaresShared(["a.ts", "b.ts"])).toBe(false);
  });
});

describe("per-path mode — shared × shared passes, shared × exclusive refuses", () => {
  it("both declare shared on the same path → passes", () => {
    const res = conflict(
      ["shared:src/main/index.ts (envio IPC do meu lado)"],
      ["shared:src/main/index.ts (registro o meu IPC, releio antes)"],
    );
    expect(res.ok).toBe(true);
  });

  it("shared on one side, exclusive on the other → refuses", () => {
    const res = conflict(["src/main/index.ts"], ["shared:src/main/index.ts (note)"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.conflictingTaskId).toBe("taskB");
      expect(res.error).toContain("BOTH declare it shared");
    }
  });

  it("exclusive on both sides over the same concrete path → refuses (as before)", () => {
    const res = conflict(["src/main/index.ts"], ["src/main/index.ts"]);
    expect(res.ok).toBe(false);
  });

  it("a `shared:` entry without a note is refused before any compare", () => {
    const res = conflict(["shared:src/main/index.ts"], ["src/main/index.ts"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("mandatory coordination note");
  });
});

describe("glob × new file", () => {
  it("a concrete path covered by an ACTIVE glob that EXISTS → refuses", () => {
    const res = conflict(["scripts/verify/smoke-a8.mjs"], ["scripts/verify/**"], {
      pathExists: () => true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("ALREADY EXISTS");
  });

  it("a NEW concrete path under a broad glob → passes WITH a warning", () => {
    const res = conflict(["scripts/verify/smoke-a8.mjs"], ["scripts/verify/**"], {
      pathExists: () => false,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0].message).toContain("does not exist on disk yet");
      expect(res.warnings[0].conflictingTaskId).toBe("taskB");
    }
  });

  it("a narrower glob nested under a broad glob → passes with a warning (not a hard block)", () => {
    const res = conflict(["scripts/verify/smoke-a8-*.mjs"], ["scripts/verify/**"]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.warnings[0].message).toContain("broader glob");
  });

  it("two globs that genuinely cross → refuses", () => {
    const res = conflict(["src/*/index.ts"], ["src/a/*/index.ts"]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("crosses");
  });
});

describe("orchestrator override", () => {
  it("a non-empty override makes a would-be refusal pass AND reports what it bypassed", () => {
    const res = conflict(["src/main/index.ts"], ["src/main/index.ts"], {
      override: "os dois cards registram o seu IPC; eu coordenei o merge",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.overridden?.reason).toContain("coordenei");
      expect(res.overridden?.conflict.conflictingTaskId).toBe("taskB");
    }
  });

  it("an empty/blank override does not bypass", () => {
    const res = conflict(["src/main/index.ts"], ["src/main/index.ts"], { override: "   " });
    expect(res.ok).toBe(false);
  });
});

describe("shared co-owners for the brief", () => {
  it("lists the other active task on a shared path", () => {
    const text = describeSharedCoOwners({
      taskId: "taskA",
      territory: ["shared:src/main/index.ts (meu IPC)"],
      cwd: BASE,
      others: [{ taskId: "taskB", territory: ["shared:src/main/index.ts (o IPC dela)"], cwd: BASE }],
    });
    expect(text).toContain("taskB");
    expect(text).toContain("o IPC dela");
  });

  it("is null when nothing is shared", () => {
    expect(
      describeSharedCoOwners({
        taskId: "taskA",
        territory: ["src/main/index.ts"],
        cwd: BASE,
        others: [{ taskId: "taskB", territory: ["src/main/index.ts"], cwd: BASE }],
      }),
    ).toBeNull();
  });
});

describe("no territory is not evidence", () => {
  it("absent territory on either side never collides", () => {
    expect(conflict(null, ["src/main/index.ts"]).ok).toBe(true);
    expect(conflict(["src/main/index.ts"], null).ok).toBe(true);
  });
});
