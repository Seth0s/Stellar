import { describe, expect, it } from "vitest";
import {
  validateGateToolPath,
  validateGateToolPaths,
  type GateToolPathProbes,
} from "../../src/main/gate-tool-paths";

/**
 * A board-declared tool directory is an extra READ-ONLY mount in the gate
 * sandbox. Validation is pure: it decides what may be mounted and why the rest
 * is refused, before any I/O touches the sandbox.
 *
 * What these tests lock:
 *   - a relative, absent, or non-directory path is refused;
 *   - the home directory itself and any ancestor of it are refused (they would
 *     re-expose the whole tree);
 *   - the secret directories under home are refused;
 *   - only a specific, existing, absolute directory is accepted, and the list
 *     keeps order without duplicates.
 */

const HOME = "/home/u";

function probes(input: { existing?: string[]; dirs?: string[] } = {}): GateToolPathProbes {
  const existing = new Set(input.existing ?? []);
  const dirs = new Set(input.dirs ?? input.existing ?? []);
  return { home: HOME, exists: (p) => existing.has(p), isDirectory: (p) => dirs.has(p) };
}

describe("validateGateToolPath", () => {
  it("accepts a specific existing absolute directory", () => {
    const path = "/home/u/Workplace/Projects/ai/scripts";
    const result = validateGateToolPath(path, probes({ existing: [path] }));
    expect(result.accepted).toBe(path);
    expect(result.refusal).toBeNull();
  });

  it("accepts a directory outside home", () => {
    const path = "/opt/tools/lint";
    expect(validateGateToolPath(path, probes({ existing: [path] })).accepted).toBe(path);
  });

  it("accepts a specific Playwright browser cache under home", () => {
    const path = `${HOME}/.cache/ms-playwright`;
    expect(validateGateToolPath(path, probes({ existing: [path] })).accepted).toBe(path);
  });

  it("refuses a relative path", () => {
    const result = validateGateToolPath("ai/scripts", probes());
    expect(result.accepted).toBeNull();
    expect(result.refusal?.reason).toBe("relative");
    expect(result.refusal?.message).toContain("absolute");
  });

  it("refuses an absent path", () => {
    const result = validateGateToolPath("/opt/missing", probes());
    expect(result.refusal?.reason).toBe("not-found");
  });

  it("refuses an existing path that is not a directory", () => {
    const result = validateGateToolPath(
      "/opt/tools/lint.sh",
      probes({ existing: ["/opt/tools/lint.sh"], dirs: [] }),
    );
    expect(result.refusal?.reason).toBe("not-a-directory");
  });

  it("refuses the home directory itself and any ancestor of it", () => {
    for (const broad of [HOME, "/home", "/"]) {
      const result = validateGateToolPath(broad, probes({ existing: [broad] }));
      expect(result.refusal?.reason).toBe("home-root");
      expect(result.refusal?.message).toContain("re-expose the whole home");
    }
  });

  it("refuses a secret directory under home", () => {
    for (const secret of [`${HOME}/.ssh`, `${HOME}/.ssh/keys`, `${HOME}/.config`, `${HOME}/.config/nvim`]) {
      const result = validateGateToolPath(secret, probes({ existing: [secret] }));
      expect(result.refusal?.reason).toBe("sensitive-home");
      expect(result.refusal?.message).toContain("holds secrets");
    }
  });

  it("refuses an empty or non-string entry", () => {
    expect(validateGateToolPath("   ", probes()).refusal?.reason).toBe("empty");
    expect(validateGateToolPath(7, probes()).refusal?.reason).toBe("empty");
  });
});

describe("validateGateToolPaths", () => {
  it("keeps declaration order and drops duplicates; a malformed list is empty", () => {
    const good = "/opt/tools/lint";
    const other = "/home/u/tools";
    const result = validateGateToolPaths([good, other, good], probes({ existing: [good, other] }));
    expect(result.accepted).toEqual([good, other]);
    expect(result.rejected).toEqual([]);
    expect(validateGateToolPaths(null, probes())).toEqual({ accepted: [], rejected: [] });
    expect(validateGateToolPaths("nope" as never, probes())).toEqual({ accepted: [], rejected: [] });
  });

  it("separates the accepted from the refused in one pass", () => {
    const good = "/opt/tools/lint";
    const result = validateGateToolPaths(["rel", "/opt/missing", good], probes({ existing: [good] }));
    expect(result.accepted).toEqual([good]);
    expect(result.rejected.map((r) => r.reason).sort()).toEqual(["not-found", "relative"]);
  });
});
