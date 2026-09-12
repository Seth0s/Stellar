import { describe, it, expect } from "vitest";
import { isIgnoredDirName, pathHasIgnoredSegment } from "../../src/main/file-watcher";

// DESIGN-BACKLOG.md §0 — "Abrir o explorador de arquivos quase derruba o
// app": `startWatching` used to hand a whole real cwd (`node_modules`,
// `.git`, etc included) to `fs.watch(root, { recursive: true })`, which on
// Linux walks the entire tree synchronously before returning. The fix
// prunes at tree-walk time instead: `isIgnoredDirName` is the pure
// decision of whether a directory NAME stops the walk from descending
// into it (and therefore from ever registering an inotify watch for it or
// anything under it). These tests exercise real directory names a repo
// tree actually has, not just a restatement of the `Set.has` call inside
// the implementation.
describe("isIgnoredDirName", () => {
  it("prunes the known heavy/noisy directories by exact name", () => {
    for (const name of ["node_modules", ".git", "dist", "target", ".verify-tmp", "build", "out", ".cache"]) {
      expect(isIgnoredDirName(name)).toBe(true);
    }
  });

  it("does not prune ordinary source directories", () => {
    for (const name of ["src", "tests", "components", "scripts", "ai", "public"]) {
      expect(isIgnoredDirName(name)).toBe(false);
    }
  });

  it("is an exact match, not a prefix/substring match — a real directory named similarly to an ignored one is not pruned", () => {
    // If this were a prefix check (the way the event-time `shouldIgnore`
    // filter is intentionally loose), these would all wrongly be pruned —
    // which for THIS function means the directory would never be watched
    // at all, not just have its events dropped.
    expect(isIgnoredDirName("distribution")).toBe(false);
    expect(isIgnoredDirName("dist-esm")).toBe(false);
    expect(isIgnoredDirName("node_modules_backup")).toBe(false);
    expect(isIgnoredDirName("builder")).toBe(false);
    expect(isIgnoredDirName("outbox")).toBe(false);
    expect(isIgnoredDirName(".github")).toBe(false);
  });

  it("is case-sensitive, matching the Linux filesystem it runs against", () => {
    expect(isIgnoredDirName("Node_Modules")).toBe(false);
    expect(isIgnoredDirName(".Git")).toBe(false);
  });
});

describe("pathHasIgnoredSegment", () => {
  it("refuses a watch path that goes through node_modules, .git, out, or dist", () => {
    expect(pathHasIgnoredSegment("node_modules")).toBe(true);
    expect(pathHasIgnoredSegment("src/node_modules/foo")).toBe(true);
    expect(pathHasIgnoredSegment(".git/objects")).toBe(true);
    expect(pathHasIgnoredSegment("out")).toBe(true);
    expect(pathHasIgnoredSegment("dist/index.js")).toBe(true);
  });

  it("does not treat the empty root path as ignored", () => {
    expect(pathHasIgnoredSegment("")).toBe(false);
    expect(pathHasIgnoredSegment("src/renderer")).toBe(false);
    expect(pathHasIgnoredSegment("distribution")).toBe(false);
  });
});
