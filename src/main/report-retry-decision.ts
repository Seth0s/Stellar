/**
 * Pure decision for in-session `report` acceptance vs refusal.
 *
 * A declared failure (`ok: false` without `retryable: false`) is refused
 * while the linked running task still has `max_retries` budget. The same
 * agent keeps its context and calls `report` again. The app never judges
 * whether a later correction actually fixed anything — refusal is only
 * the retry mechanic.
 *
 * Terminal failure (`ok: false` AND `retryable: false`) is the honest
 * exit: accepted immediately, no retry spent. Without that mark, a
 * refused-until-ok:true loop would teach the agent to lie.
 */

export type ReportRetryLinkedTask = {
  status: string;
  retry_count: number;
  max_retries: number | null;
};

export type ReportRetryDecision =
  | { action: "structural"; field: string; error: string }
  | { action: "refuse_retryable"; retryCount: number; retriesRemaining: number; error: string }
  | { action: "accept_failure"; terminal: boolean }
  | { action: "accept" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural refusal: the app knows the missing/wrong field by name. */
export function describeStructuralReportError(field: string): string {
  if (field === "requesterId") return "missing requesterId (your own card id)";
  if (field === "report") return "missing report";
  if (field === "ok") return "report.ok must be a boolean";
  if (field === "retryable") return "report.retryable must be a boolean";
  return `missing ${field}`;
}

/**
 * Refusal for an agent-declared retryable failure. The app does not know
 * what broke — only the acceptance rule and remaining attempts.
 */
export function describeRetryableFailureRefusal(retriesRemaining: number): string {
  return (
    "Declared failure is not accepted while retry attempts remain. " +
    "This report is accepted when it declares success (ok: true) or a terminal failure (ok: false with retryable: false). " +
    `Attempts remaining: ${retriesRemaining}. ` +
    "The app does not evaluate the contents — only this acceptance rule."
  );
}

export function errorFromReportPayload(report: unknown): string {
  if (isPlainObject(report) && typeof report.error === "string" && report.error.trim()) {
    return report.error.trim();
  }
  return "agent reported a failure";
}

/**
 * Last refused payload, stashed on the running task so a later
 * `exit_without_report` can name the real reason. Top-level only —
 * `failureKindFromResultJson` ignores this key. Never write `failureKind`
 * here: a stash is not a status.
 */
export const LAST_REFUSED_REPORT_KEY = "lastRefusedReport";

function parseResultObject(existingJson: string | null | undefined): Record<string, unknown> {
  if (!existingJson) return {};
  try {
    const parsed = JSON.parse(existingJson) as unknown;
    if (isPlainObject(parsed)) return { ...parsed };
  } catch {
    return { _raw: existingJson };
  }
  return {};
}

/** Merge the refused payload into result_json without stamping a kind. */
export function stashLastRefusedReport(existingJson: string | null | undefined, report: unknown): string {
  const base = parseResultObject(existingJson);
  base[LAST_REFUSED_REPORT_KEY] = report;
  return JSON.stringify(base);
}

export function lastRefusedReasonFromResultJson(resultJson: string | null | undefined): string | null {
  const base = parseResultObject(resultJson);
  if (!(LAST_REFUSED_REPORT_KEY in base)) return null;
  return errorFromReportPayload(base[LAST_REFUSED_REPORT_KEY]);
}

/** Drop a superseded stash (an accepted report replaced it). */
export function clearLastRefusedStash(existingJson: string | null | undefined): string | null {
  if (!existingJson) return existingJson ?? null;
  const base = parseResultObject(existingJson);
  if (!(LAST_REFUSED_REPORT_KEY in base)) return existingJson;
  delete base[LAST_REFUSED_REPORT_KEY];
  return Object.keys(base).length === 0 ? null : JSON.stringify(base);
}

export function describeExitWithoutAcceptedReport(exitCode: number, lastRefusedReason: string | null): string {
  if (lastRefusedReason) {
    return `process exited (code ${exitCode}) after a refused report; last declared failure: ${lastRefusedReason}`;
  }
  return `process exited (code ${exitCode}) without ever calling report`;
}

export function decideReportAcceptance(input: {
  requesterId?: string;
  report: unknown;
  linkedTask: ReportRetryLinkedTask | undefined;
  defaultMaxRetries: number;
}): ReportRetryDecision {
  if (!input.requesterId) {
    return { action: "structural", field: "requesterId", error: describeStructuralReportError("requesterId") };
  }
  if (input.report === undefined) {
    return { action: "structural", field: "report", error: describeStructuralReportError("report") };
  }

  if (!isPlainObject(input.report)) {
    return { action: "accept" };
  }

  if ("ok" in input.report && typeof input.report.ok !== "boolean") {
    return { action: "structural", field: "ok", error: describeStructuralReportError("ok") };
  }
  if ("retryable" in input.report && typeof input.report.retryable !== "boolean") {
    return { action: "structural", field: "retryable", error: describeStructuralReportError("retryable") };
  }

  if (input.report.ok !== false) {
    return { action: "accept" };
  }

  const terminal = input.report.retryable === false;
  if (terminal) {
    return { action: "accept_failure", terminal: true };
  }

  const task = input.linkedTask;
  if (!task || task.status !== "running") {
    return { action: "accept_failure", terminal: false };
  }

  const maxRetries = task.max_retries ?? input.defaultMaxRetries;
  const retriesRemainingNow = Math.max(0, maxRetries - task.retry_count);
  if (retriesRemainingNow > 0) {
    const retryCount = task.retry_count + 1;
    const retriesRemaining = Math.max(0, maxRetries - retryCount);
    return {
      action: "refuse_retryable",
      retryCount,
      retriesRemaining,
      error: describeRetryableFailureRefusal(retriesRemaining),
    };
  }

  return { action: "accept_failure", terminal: false };
}
