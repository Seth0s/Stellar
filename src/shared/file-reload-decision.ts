/**
 * What to do when a file that is already open in FilesCard changes on
 * disk. Pure: no IPC, no editor widget. The rule this exists to protect
 * is the one in the task — overwriting what the person typed is worse
 * than leaving the tree/editor briefly stale.
 *
 * Clean tab + disk still readable and different → take disk (the buffer
 * is a cache of the file, not a draft). Dirty tab → keep the draft,
 * even if disk is gone; the user already has a "click again to close"
 * confirm for discarding it. Flagging is how the card tells them the
 * two copies diverged, without a one-click reload that would eat the
 * draft.
 */

export type DiskConflictFlag = "modified" | "gone";

export type OpenFileDiskDecision =
  | { action: "reload" }
  | { action: "keep" }
  | { action: "keep-and-flag"; flag: DiskConflictFlag };

export function decideOpenFileOnDiskChange(input: {
  dirty: boolean;
  diskContent: string | null;
  editorContent: string | null;
}): OpenFileDiskDecision {
  if (input.dirty) {
    if (input.diskContent === null) return { action: "keep-and-flag", flag: "gone" };
    if (input.diskContent === input.editorContent) return { action: "keep" };
    return { action: "keep-and-flag", flag: "modified" };
  }
  if (input.diskContent === null) return { action: "keep-and-flag", flag: "gone" };
  if (input.diskContent === input.editorContent) return { action: "keep" };
  return { action: "reload" };
}
