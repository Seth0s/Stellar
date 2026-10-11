/**
 * Explicit return-for-rework (`changes_requested`): not terminal judgment
 * (done/failed), so the board orchestrator may write it even when
 * review="wanted". Pure helpers for authorship, payload shape, and the
 * result_json stamp the phase / get_task surface read.
 */

import { TASK_CARD_IMPLEMENTER_ROLE, TASK_CARD_REVIEWER_ROLE } from "../task-purpose";

export const CHANGES_REQUESTED_STATUS = "changes_requested";
export const CHANGES_REQUESTED_KEY = "changesRequested";

export type ChangesRequestedStamp = {
  reason: string;
  by: string | null;
  at: number;
};

export type ChangesRequestedWriteDecision =
  | { action: "allow" }
  | { action: "refuse"; error: string };

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeChangesRequestedAuthorshipRefusal(): string {
  return (
    `[de: stellar] update_task status "${CHANGES_REQUESTED_STATUS}" refused: ` +
    `only the board's marked orchestrator, a linked reviewer, or the human may return a task for rework. ` +
    `An implementer never writes this — keep working, or use request_task_status.`
  );
}

/** AGENT-FACING — DO NOT TRANSLATE. */
export function describeChangesRequestedWithoutReason(): string {
  return (
    `[de: stellar] status "${CHANGES_REQUESTED_STATUS}" requires requestChanges: { reason } ` +
    `(a short non-empty reason). A silent return leaves the Queue stuck in review.`
  );
}

/**
 * Who may write status `changes_requested`. Distinct from judgment
 * (done/failed): review="wanted" does NOT bar the marked orchestrator.
 */
export function decideChangesRequestedWrite(input: {
  requesterId: string | null | undefined;
  requesterRoleOnTask: string | null;
  orchestratorCardId: string | null | undefined;
}): ChangesRequestedWriteDecision {
  const reqId = typeof input.requesterId === "string" ? input.requesterId : null;
  if (reqId === "human:ui") return { action: "allow" };
  if (input.requesterRoleOnTask === TASK_CARD_IMPLEMENTER_ROLE) {
    return { action: "refuse", error: describeChangesRequestedAuthorshipRefusal() };
  }
  if (reqId && input.orchestratorCardId && reqId === input.orchestratorCardId) {
    return { action: "allow" };
  }
  if (input.requesterRoleOnTask === TASK_CARD_REVIEWER_ROLE) {
    return { action: "allow" };
  }
  return { action: "refuse", error: describeChangesRequestedAuthorshipRefusal() };
}

export function normalizeChangesRequestedReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  return reason.length > 0 ? reason : null;
}

export function normalizeChangesRequested(
  raw: unknown,
  at: number,
  by: string | null,
): ChangesRequestedStamp | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const reason = normalizeChangesRequestedReason((raw as { reason?: unknown }).reason);
  if (!reason) return null;
  const stampedAt =
    typeof (raw as { at?: unknown }).at === "number" && Number.isFinite((raw as { at: number }).at)
      ? (raw as { at: number }).at
      : at;
  const stampedBy =
    typeof (raw as { by?: unknown }).by === "string" ? (raw as { by: string }).by : by;
  return { reason, by: stampedBy, at: stampedAt };
}

function parseResultObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    return { _raw: json };
  }
  return {};
}

export function changesRequestedFromResultJson(
  json: string | null | undefined,
): ChangesRequestedStamp | null {
  const raw = parseResultObject(json)[CHANGES_REQUESTED_KEY];
  return normalizeChangesRequested(raw, 0, null);
}

export function stampChangesRequestedJson(
  existingJson: string | null | undefined,
  stamp: ChangesRequestedStamp,
): string {
  const base = parseResultObject(existingJson);
  base[CHANGES_REQUESTED_KEY] = stamp;
  return JSON.stringify(base);
}

export function clearChangesRequestedJson(existingJson: string | null | undefined): string | null {
  if (!existingJson) return existingJson ?? null;
  const base = parseResultObject(existingJson);
  if (!(CHANGES_REQUESTED_KEY in base)) return existingJson;
  delete base[CHANGES_REQUESTED_KEY];
  return JSON.stringify(base);
}

/** Keep an existing stamp across a later `result` merge that omitted it. */
export function carryChangesRequested(
  previousJson: string | null | undefined,
  nextJson: string | null | undefined,
): string | null | undefined {
  const previous = changesRequestedFromResultJson(previousJson);
  if (!previous) return nextJson;
  if (changesRequestedFromResultJson(nextJson)) return nextJson;
  return stampChangesRequestedJson(nextJson, previous);
}

/** Short reason from a reviewer report body when status is stamped from verdict. */
export function reasonFromReviewReport(report: unknown): string {
  if (report && typeof report === "object" && !Array.isArray(report)) {
    const o = report as Record<string, unknown>;
    for (const key of ["reason", "error", "summary", "decisaoTomada"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 280);
    }
  }
  return "reprovado";
}
