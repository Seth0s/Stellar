import { describe, expect, it } from "vitest";
import { decideBreadcrumbSymbol } from "../../src/renderer/src/code-breadcrumb-symbol-decision";

describe("decideBreadcrumbSymbol", () => {
  const src = `import x from "y";\n\nexport async function replayInto(term: unknown) {\n  await fit();\n}\n`;

  it("finds the enclosing function", () => {
    expect(decideBreadcrumbSymbol(src, 4)).toBe("replayInto");
  });

  it("returns null when nothing matches", () => {
    expect(decideBreadcrumbSymbol("// only comment\n", 1)).toBeNull();
  });
});
