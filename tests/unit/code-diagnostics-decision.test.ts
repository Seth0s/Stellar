import { describe, expect, it } from "vitest";
import { decideCodeProblems, decideParseCheckerOutput } from "../../src/renderer/src/code-diagnostics-decision";

describe("decideCodeProblems", () => {
  it("maps categories and drops empty messages", () => {
    const problems = decideCodeProblems([
      { file: "a.ts", line: 3, message: "boom", category: "error" },
      { file: "b.ts", line: 1, message: "soft", category: "warning" },
      { file: "c.ts", line: 1, message: "  ", category: "error" },
    ]);
    expect(problems).toEqual([
      { path: "a.ts", line: 3, message: "boom", severity: "error" },
      { path: "b.ts", line: 1, message: "soft", severity: "warning" },
    ]);
  });
});

describe("decideParseCheckerOutput", () => {
  it("parses tsc --pretty false lines", () => {
    const raw = decideParseCheckerOutput(
      `src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n` +
        `src/b.ts(1,1): warning TS6133: 'x' is declared but its value is never read.\n`,
    );
    expect(raw).toEqual([
      {
        file: "src/a.ts",
        line: 12,
        message: "Type 'string' is not assignable to type 'number'.",
        category: "error",
      },
      {
        file: "src/b.ts",
        line: 1,
        message: "'x' is declared but its value is never read.",
        category: "warning",
      },
    ]);
  });

  it("parses eslint unix lines", () => {
    const raw = decideParseCheckerOutput(`src/a.ts:3:1: Unexpected var [Error/no-var]`);
    expect(raw[0]).toMatchObject({ file: "src/a.ts", line: 3, category: "error" });
  });
});
