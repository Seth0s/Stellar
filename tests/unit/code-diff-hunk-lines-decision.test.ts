import { describe, expect, it } from "vitest";
import { decideDiffHunkRangesForFile } from "../../src/renderer/src/code-diff-hunk-lines-decision";

describe("decideDiffHunkRangesForFile", () => {
  const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,4 @@
 keep
+added1
+added2
 keep2
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10 +10,2 @@
-old
+new1
+new2
`;

  it("returns new-side ranges for the requested file only", () => {
    expect(decideDiffHunkRangesForFile(patch, "src/a.ts")).toEqual([{ fromLine: 1, toLine: 4 }]);
    expect(decideDiffHunkRangesForFile(patch, "src/b.ts")).toEqual([{ fromLine: 10, toLine: 11 }]);
  });

  it("returns empty when the file is absent", () => {
    expect(decideDiffHunkRangesForFile(patch, "missing.ts")).toEqual([]);
  });
});
