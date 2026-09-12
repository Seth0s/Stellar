/**
 * DESIGN-BACKLOG.md §2.1 "Falha TIPADA: julgada vs interrompida".
 *
 * No new kanban column — four columns stay. The app DERIVES the kind from
 * a typed *cause* (never assumed inside the write choke point):
 *   - exit_without_report → interrompida (work never happened)
 *   - explicit_failed → julgada (agent update_task / human drag)
 *   - spawn_failed / retry_spawn_failed → interrompida *unless* the task
 *     already carries julgada — a judged failure is never downgraded
 *     when a later spawn/retry fails (that would erase the judgment and
 *     bounce the task back to "a fazer" alone).
 *
 * Write mapping:
 *   - interrompida → status pending ("a fazer") + visible reason
 *   - julgada → status failed; stays, does not migrate, counts in snapshot
 */

export type FailureKind = "julgada" | "interrompida";

/**
 * Typed cause for `markTaskFailed` / explicit fail paths.
 * Distinct causes stay distinct — `retry_spawn_failed` is NOT
 * `exit_without_report` (same infra class for the default mapping, but
 * a different signature when cause-aware retry lands later).
 */
export type FailureSource = "exit_without_report" | "explicit_failed" | "spawn_failed" | "retry_spawn_failed";

/** Default kind for a cause, ignoring any prior stamp on the task. */
export function decideFailureKind(source: FailureSource): FailureKind {
  return source === "explicit_failed" ? "julgada" : "interrompida";
}

/**
 * Effective kind for a mark/write: never downgrade julgada to interrompida.
 * A task already judged stays judged even if a later spawn/retry fails.
 */
export function resolveFailureKind(existing: FailureKind | null | undefined, source: FailureSource): FailureKind {
  if (existing === "julgada") return "julgada";
  return decideFailureKind(source);
}

export type FailureWrite = {
  /** Column status to persist. Interrompida returns to todo. */
  status: "pending" | "failed";
  failureKind: FailureKind;
};

export function decideFailureWrite(kind: FailureKind): FailureWrite {
  if (kind === "interrompida") return { status: "pending", failureKind: "interrompida" };
  return { status: "failed", failureKind: "julgada" };
}

/** Merge `failureKind` into an existing result_json payload (preserves
 * other keys like `error`). Pure — no I/O. */
export function stampFailureKindJson(existingJson: string | null | undefined, kind: FailureKind, error?: string): string {
  let base: Record<string, unknown> = {};
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Non-JSON legacy payload — keep as opaque string under `_raw`.
      base = { _raw: existingJson };
    }
  }
  base.failureKind = kind;
  if (error !== undefined) base.error = error;
  return JSON.stringify(base);
}

/** Read failureKind from result_json; null if absent/unparseable. */
export function failureKindFromResultJson(resultJson: string | null | undefined): FailureKind | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as { failureKind?: unknown };
    if (parsed?.failureKind === "julgada" || parsed?.failureKind === "interrompida") {
      return parsed.failureKind;
    }
  } catch {
    return null;
  }
  return null;
}

/** Visible interruption reason for the Fila card (todo after interrompida). */
export function interruptionReasonFromResultJson(resultJson: string | null | undefined): string | null {
  if (!resultJson) return null;
  try {
    const parsed = JSON.parse(resultJson) as { failureKind?: unknown; error?: unknown };
    if (parsed?.failureKind !== "interrompida") return null;
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    return "interrompida";
  } catch {
    return null;
  }
}
