/**
 * Preflight on staged additions — catches debug that rides a filtered
 * commit inside tracked `src/` (the untracked-artifact path cannot).
 *
 * Fixtures are real commit diffs via `git show` (read-only). The shared
 * index is never touched.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  classifyAddition,
  formatFindings,
  isScannedPath,
  scanStagedDiff,
} from "../../scripts/preflight-staged.mjs";

const REPO = process.cwd();

function showDiff(commit: string): string {
  return execFileSync("git", ["show", commit, "-U0", "--format=", "--no-ext-diff"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

describe("preflight-staged path filter", () => {
  it("scans src/ production files only", () => {
    expect(isScannedPath("src/renderer/src/useTerminal.ts")).toBe(true);
    expect(isScannedPath("src/main/message-bus.ts")).toBe(true);
    expect(isScannedPath("scripts/verify/smoke-x.mjs")).toBe(false);
    expect(isScannedPath("tests/unit/foo.test.ts")).toBe(false);
    expect(isScannedPath("src/renderer/src/foo.test.ts")).toBe(false);
  });
});

describe("preflight-staged classifyAddition", () => {
  it("flags window.__*, debugger, console, DEBUG, TODO remove", () => {
    expect(classifyAddition('const D = (window as unknown as Record<string, unknown>).__turnEndDiag')).toBe(
      "window.__*",
    );
    expect(classifyAddition("window.__turnEndDiag = {}")).toBe("window.__*");
    expect(classifyAddition("  debugger;")).toBe("debugger");
    expect(classifyAddition('  console.log("x")')).toBe("console.log/debug");
    expect(classifyAddition("  console.debug(x)")).toBe("console.log/debug");
    expect(classifyAddition("  // DEBUG temp")).toBe("// DEBUG");
    expect(classifyAddition("  // TODO remove after measure")).toBe("TODO remove");
  });

  it("honours // preflight:allow <reason> on the same line", () => {
    expect(
      classifyAddition("window.__probe = 1; // preflight:allow smoke harness probe"),
    ).toBeNull();
    expect(classifyAddition("window.__probe = 1; // preflight:allow")).toBe("window.__*");
    expect(classifyAddition("console.log(1)")).toBe("console.log/debug");
  });

  it("ignores console.log / window.__* inside comments and string literals", () => {
    expect(classifyAddition("// não use console.log(foo)")).toBeNull();
    expect(classifyAddition('const tip = "Do not call console.log() in production"')).toBeNull();
    expect(classifyAddition('const tip = "touch window.__x never"')).toBeNull();
    expect(classifyAddition("/* console.debug(x) */ const y = 1")).toBeNull();
    expect(classifyAddition("const s = `debug window.__turnEndDiag later`")).toBeNull();
  });
});

describe("preflight-staged against real commits", () => {
  it("flags useTerminal.ts on the 4d71430 diff (debug that landed in main)", () => {
    const findings = scanStagedDiff(showDiff("4d71430"));
    const hits = findings.filter((f) => f.path.endsWith("useTerminal.ts"));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((f) => f.rule === "window.__*")).toBe(true);
    expect(formatFindings(findings)).toContain("useTerminal.ts");
  });

  it("is clean on the 90c52a3 diff (debug removed)", () => {
    const findings = scanStagedDiff(showDiff("90c52a3"));
    expect(findings).toEqual([]);
    expect(formatFindings(findings)).toBe("preflight:staged: clean\n");
  });

  it("finds nothing on three ordinary recent commits (src/ additions)", () => {
    // These SHAs are ordinary recent main commits whose src/ additions stay
    // outside the debug patterns this preflight flags.
    const commits = [
      "5dff0e5", // docs: caixa de mensagens, dados do design v3…
      "6cc876f", // fix(delivery): sent passa a EXIGIR evidencia positiva…
      "05bc256", // feat(mcp): o par linkTaskId/linkRole…
    ] as const;
    for (const sha of commits) {
      const findings = scanStagedDiff(showDiff(sha));
      expect(findings, `expected clean staged-addition scan for ${sha}`).toEqual([]);
    }
  });
});
