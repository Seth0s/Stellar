/**
 * DESIGN-BACKLOG.md §2.1 "Falha TIPADA: julgada vs interrompida".
 *
 * No new kanban column — four columns stay. The app DERIVES the kind:
 *   - exit without report/verdict → interrompida (work never happened)
 *   - update_task status=failed (agent) or human drag to "falhou" → julgada
 *
 * Write mapping:
 *   - interrompida → status pending ("a fazer") + visible reason; does NOT
 *     occupy the failed column and does NOT count as a sprint failure.
 *   - julgada → status failed; stays, does not migrate, counts in snapshot.
 */

export type FailureKind = "julgada" | "interrompida";

/** How the app observed the failure — never a free-form field from the model. */
export type FailureSource = "exit_without_report" | "explicit_failed";

export function decideFailureKind(source: FailureSource): FailureKind {
  return source === "exit_without_report" ? "interrompida" : "julgada";
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
