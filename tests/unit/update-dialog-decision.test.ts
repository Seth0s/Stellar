import { describe, it, expect } from "vitest";
import {
  canCloseDialog,
  closeLabelKey,
  errorCopy,
  runningParts,
  runningWarning,
  sessionsKey,
} from "../../src/renderer/src/update-dialog-decision";

describe("closing the dialog", () => {
  it("is allowed in every phase but installing", () => {
    for (const phase of ["idle", "available", "downloading", "ready", "error", "manual"] as const) {
      expect(canCloseDialog(phase)).toBe(true);
    }
    expect(canCloseDialog("installing")).toBe(false);
  });

  it("tells the user the download goes on when closing a running or finished one", () => {
    expect(closeLabelKey("available")).toBe("update.dialog.close");
    expect(closeLabelKey("manual")).toBe("update.dialog.close");
    expect(closeLabelKey("downloading")).toBe("update.dialog.closeKeepsDownload");
    expect(closeLabelKey("ready")).toBe("update.dialog.closeKeepsDownload");
  });
});

describe("what a restart would end", () => {
  it("is pending until counted, unknown if the count failed", () => {
    expect(runningWarning(null)).toEqual({ kind: "pending" });
    expect(runningWarning("unknown")).toEqual({ kind: "unknown" });
  });

  it("is `none` only when nothing at all is running", () => {
    expect(runningWarning({ terminals: 0, agents: 0, sessions: 0 })).toEqual({ kind: "none" });
    expect(runningWarning({ terminals: 3, agents: 2, sessions: 2 })).toEqual({ kind: "some", terminals: 3, agents: 2, sessions: 2 });
    expect(runningWarning({ terminals: 0, agents: 1, sessions: 1 }).kind).toBe("some");
  });

  it("phrases counts with the right plural and skips a zero", () => {
    expect(runningParts({ terminals: 3, agents: 2 })).toEqual({
      parts: [
        { key: "update.dialog.running.terminal.other", count: 3 },
        { key: "update.dialog.running.agent.other", count: 2 },
      ],
      total: 5,
    });
    expect(runningParts({ terminals: 1, agents: 0 }).parts).toEqual([{ key: "update.dialog.running.terminal.one", count: 1 }]);
    expect(runningParts({ terminals: 0, agents: 1 }).parts).toEqual([{ key: "update.dialog.running.agent.one", count: 1 }]);
    expect(sessionsKey(1)).toBe("update.dialog.running.session.one");
    expect(sessionsKey(2)).toBe("update.dialog.running.session.other");
  });
});

describe("error copy", () => {
  const base = { stage: "download" as const, percent: null, neededBytes: null, freeBytes: null };

  it("has one message per cause", () => {
    expect(errorCopy({ ...base, kind: "signature" }).titleKey).toBe("update.dialog.error.signature.title");
    expect(errorCopy({ ...base, kind: "network", percent: 62 }).textKey).toBe("update.dialog.error.network.text");
    expect(errorCopy({ ...base, kind: "network" }).textKey).toBe("update.dialog.error.network.textNoPercent");
  });

  it("only quotes disk numbers it has", () => {
    expect(errorCopy({ ...base, kind: "disk", neededBytes: 1, freeBytes: 0 }).textKey).toBe("update.dialog.error.disk.text");
    expect(errorCopy({ ...base, kind: "disk" }).textKey).toBe("update.dialog.error.disk.textNoNumbers");
  });

  it("separates an install failure from a download failure of unknown cause", () => {
    expect(errorCopy({ ...base, kind: "unknown", stage: "install" }).titleKey).toBe("update.dialog.error.install.title");
    expect(errorCopy({ ...base, kind: "unknown" }).titleKey).toBe("update.dialog.error.unknown.title");
  });
});
