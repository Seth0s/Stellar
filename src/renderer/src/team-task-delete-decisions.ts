/**
 * ARCHIVE / DELETE A TASK — the pure dialog decisions (no React, no I/O).
 *
 * Screen 17: the confirmation dialog. This module owns the "what happens before
 * you decide" impact list, the archive-vs-purge choice and the "#id" typing
 * rule the two destructive actions share.
 */

import type { TeamTaskDependencyInfo, TeamTaskInfo } from "../../preload/index";
import type { MessageKey } from "../../shared/i18n";

export type DeleteMode = "archive" | "purge";

export type DeleteImpact = { key: MessageKey; params?: Record<string, string> };

/** What the dialog spells out before the user decides: the running agent (if
 *  any), each dependent task, and where the history goes. */
export function deleteImpact(task: Pick<TeamTaskInfo, "state">, dependents: readonly TeamTaskDependencyInfo[]): DeleteImpact[] {
  const out: DeleteImpact[] = [];
  if (task.state === "rodando") out.push({ key: "teamTask.delete.impact.agent" });
  for (const dep of dependents) {
    out.push({ key: "teamTask.delete.impact.dependent", params: { ref: `#${dep.shortId}`, title: dep.title } });
  }
  out.push({ key: "teamTask.delete.impact.history" });
  return out;
}

/** The typed confirmation is the bare id: "#58" and "58" are the same. */
export function normalizeConfirm(value: string): string {
  return value.trim().replace(/^#/, "");
}

export function canConfirmDelete(input: string, ref: string): boolean {
  const typed = normalizeConfirm(input);
  return typed !== "" && typed === normalizeConfirm(ref);
}

/** The primary button's label key for the chosen mode. */
export function deleteSubmitKey(mode: DeleteMode): MessageKey {
  return mode === "purge" ? "teamTask.delete.submitPurge" : "teamTask.delete.submitArchive";
}

/** The subtitle shown when the task is running or has dependents. */
export function deleteDescriptionKey(task: Pick<TeamTaskInfo, "state">, dependents: readonly TeamTaskDependencyInfo[]): MessageKey {
  const risky = task.state === "rodando" || dependents.length > 0;
  return risky ? "teamTask.delete.descRisky" : "teamTask.delete.desc";
}
