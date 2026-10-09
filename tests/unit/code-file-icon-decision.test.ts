import { describe, expect, it } from "vitest";
import {
  decideCodeFileBadge,
  decideGitLetter,
  gitLetterColor,
} from "../../src/renderer/src/code-file-icon-decision";

describe("decideCodeFileBadge", () => {
  it("maps the prototype language set", () => {
    expect(decideCodeFileBadge("useTerminal.ts")).toEqual({
      text: "TS",
      background: "#3178c6",
      color: "#fff",
    });
    expect(decideCodeFileBadge("TaskCard.tsx").text).toBe("⚛");
    expect(decideCodeFileBadge("x.module.css").text).toBe("#");
    expect(decideCodeFileBadge("package.json").text).toBe("{}");
    expect(decideCodeFileBadge("MOBILE_V1.md").text).toBe("M↓");
    expect(decideCodeFileBadge("main.go").text).toBe("Go");
    expect(decideCodeFileBadge("app.py").text).toBe("Py");
    expect(decideCodeFileBadge("lib.rs").text).toBe("Rs");
    expect(decideCodeFileBadge("build.sh").text).toBe("$");
    expect(decideCodeFileBadge("q.sql").text).toBe("SQL");
    expect(decideCodeFileBadge("icon.png").text).toBe("▣");
  });

  it("prefers the test badge over the language letter", () => {
    expect(decideCodeFileBadge("terminal-replay.test.ts")).toEqual({
      text: "✓",
      background: "#14301f",
      color: "#7ee2a0",
    });
  });
});

describe("decideGitLetter", () => {
  it("maps porcelain status to M/A/D", () => {
    expect(decideGitLetter("M")).toBe("M");
    expect(decideGitLetter("A")).toBe("A");
    expect(decideGitLetter("??")).toBe("A");
    expect(decideGitLetter("D")).toBe("D");
    expect(decideGitLetter(null)).toBeNull();
    expect(gitLetterColor("M")).toBe("#f0b25c");
    expect(gitLetterColor("A")).toBe("#8fdcc0");
  });
});
