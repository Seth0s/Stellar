import { describe, it, expect } from "vitest";
import { decideOpenFileOnDiskChange } from "../../src/shared/file-reload-decision";

// Care 3 of the FilesCard live-sync task: an OPEN dirty buffer must not
// be replaced by whatever just landed on disk. Overwriting typed text
// is worse than showing a stale tree. These cases are the whole policy.
describe("decideOpenFileOnDiskChange", () => {
  it("reloads a clean tab when disk content actually changed", () => {
    expect(
      decideOpenFileOnDiskChange({
        dirty: false,
        diskContent: "new from agent",
        editorContent: "old snapshot",
      }),
    ).toEqual({ action: "reload" });
  });

  it("keeps a clean tab that already matches disk — no pointless rewrite", () => {
    expect(
      decideOpenFileOnDiskChange({
        dirty: false,
        diskContent: "same",
        editorContent: "same",
      }),
    ).toEqual({ action: "keep" });
  });

  it("never overwrites a dirty tab; flags that disk moved on", () => {
    expect(
      decideOpenFileOnDiskChange({
        dirty: true,
        diskContent: "agent wrote this",
        editorContent: "what the person typed",
      }),
    ).toEqual({ action: "keep-and-flag", flag: "modified" });
  });

  it("keeps a dirty tab even when the file vanished on disk", () => {
    expect(
      decideOpenFileOnDiskChange({
        dirty: true,
        diskContent: null,
        editorContent: "draft still here",
      }),
    ).toEqual({ action: "keep-and-flag", flag: "gone" });
  });

  it("does not flag a dirty tab whose buffer happens to equal the new disk copy", () => {
    // User typed the same bytes the agent just wrote (or autosave raced).
    // The draft is still theirs; we just have nothing to warn about.
    expect(
      decideOpenFileOnDiskChange({
        dirty: true,
        diskContent: "same bytes",
        editorContent: "same bytes",
      }),
    ).toEqual({ action: "keep" });
  });

  it("flags a clean tab whose file vanished rather than wiping the editor", () => {
    expect(
      decideOpenFileOnDiskChange({
        dirty: false,
        diskContent: null,
        editorContent: "last known",
      }),
    ).toEqual({ action: "keep-and-flag", flag: "gone" });
  });
});
