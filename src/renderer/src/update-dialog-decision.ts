/**
 * WHAT THE UPDATE DIALOG SAYS AND OFFERS in each state — pure decisions, so the
 * copy rules are testable and the component only draws.
 */
import type { UpdateErrorKind } from "../../main/update-error-decision";
import type { UpdaterError, UpdaterPhase } from "../../main/update-state";
import type { MessageKey } from "../../shared/i18n";

/** The dialog can be closed except while the app is about to restart. */
export function canCloseDialog(phase: UpdaterPhase): boolean {
  return phase !== "installing";
}

/** Closing while a download runs does not cancel it — the label says so. */
export function closeLabelKey(phase: UpdaterPhase): MessageKey {
  return phase === "downloading" || phase === "ready" || phase === "error"
    ? "update.dialog.closeKeepsDownload"
    : "update.dialog.close";
}

export type RunningCounts = { terminals: number; agents: number; sessions: number };

/** What a restart would end: nothing, something, or unknown (the count failed). */
export type RunningWarning =
  | { kind: "pending" }
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "some"; terminals: number; agents: number; sessions: number };

export function runningWarning(counts: RunningCounts | null | "unknown"): RunningWarning {
  if (counts === null) return { kind: "pending" };
  if (counts === "unknown") return { kind: "unknown" };
  if (counts.terminals + counts.agents === 0) return { kind: "none" };
  return { kind: "some", ...counts };
}

/** `terminals`/`agents` phrased with the right singular or plural, joined with "e". */
export function runningParts(w: { terminals: number; agents: number }): {
  parts: { key: MessageKey; count: number }[];
  total: number;
} {
  const parts: { key: MessageKey; count: number }[] = [];
  if (w.terminals > 0) {
    parts.push({ key: w.terminals === 1 ? "update.dialog.running.terminal.one" : "update.dialog.running.terminal.other", count: w.terminals });
  }
  if (w.agents > 0) {
    parts.push({ key: w.agents === 1 ? "update.dialog.running.agent.one" : "update.dialog.running.agent.other", count: w.agents });
  }
  return { parts, total: w.terminals + w.agents };
}

export function sessionsKey(sessions: number): MessageKey {
  return sessions === 1 ? "update.dialog.running.session.one" : "update.dialog.running.session.other";
}

/** Copy for each failure cause; the network message depends on whether a percentage is known. */
export function errorCopy(error: Pick<UpdaterError, "kind" | "stage" | "percent" | "neededBytes" | "freeBytes">): {
  titleKey: MessageKey;
  textKey: MessageKey;
  hintKey: MessageKey;
} {
  const kind: UpdateErrorKind = error.kind;
  if (kind === "network") {
    return {
      titleKey: "update.dialog.error.network.title",
      textKey: error.percent === null ? "update.dialog.error.network.textNoPercent" : "update.dialog.error.network.text",
      hintKey: "update.dialog.error.network.hint",
    };
  }
  if (kind === "signature") {
    return {
      titleKey: "update.dialog.error.signature.title",
      textKey: "update.dialog.error.signature.text",
      hintKey: "update.dialog.error.signature.hint",
    };
  }
  if (kind === "disk") {
    return {
      titleKey: "update.dialog.error.disk.title",
      textKey:
        error.neededBytes !== null && error.freeBytes !== null
          ? "update.dialog.error.disk.text"
          : "update.dialog.error.disk.textNoNumbers",
      hintKey: "update.dialog.error.disk.hint",
    };
  }
  return {
    titleKey: error.stage === "install" ? "update.dialog.error.install.title" : "update.dialog.error.unknown.title",
    textKey: error.stage === "install" ? "update.dialog.error.install.text" : "update.dialog.error.unknown.text",
    hintKey: "update.dialog.error.unknown.hint",
  };
}
