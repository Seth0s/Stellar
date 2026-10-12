import { describe, expect, it } from "vitest";
import { decideLanguageName } from "../../src/renderer/src/code-language-name-decision";

describe("decideLanguageName", () => {
  it("spells the language out", () => {
    expect(decideLanguageName("src/a.ts")).toBe("TypeScript");
    expect(decideLanguageName("src/A.TSX")).toBe("TypeScript React");
    expect(decideLanguageName("docs/guide.md")).toBe("Markdown");
    expect(decideLanguageName("a/b.c.json")).toBe("JSON");
  });

  it("is null without a known extension", () => {
    expect(decideLanguageName("Makefile")).toBeNull();
    expect(decideLanguageName("a/b.unknownext")).toBeNull();
    expect(decideLanguageName("dir.d/file")).toBeNull();
  });
});
