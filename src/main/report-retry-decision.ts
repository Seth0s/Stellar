/**
 * Pure decision for in-session `report` acceptance vs refusal.
 *
 * A declared failure (`ok: false` without `retryable: false`) is refused
 * while the linked task is STILL IN PARTICIPATION and has `max_retries`
 * budget. The same agent keeps its context and calls `report` again. The
 * app never judges whether a later correction actually fixed anything —
 * refusal is only the retry mechanic.
 *
 * `inParticipation` — not `status` (task b41ac547): the fact this decision
 * needs is "is there a live implementer on this task NOW?", asked by its own
 * name. It used to arrive folded into `status` as the string `"running"` —
 * a value production can no longer store (`running` is never authoritative),
 * so the field could only ever match by accident. Renaming it is what makes
 * "keep the old field" impossible instead of silently disabling the retry
 * budget for every agent.
 *
 * Terminal failure (`ok: false` AND `retryable: false`) is the honest
 * exit: accepted immediately, no retry spent. Without that mark, a
 * refused-until-ok:true loop would teach the agent to lie.
 *
 * When the linked task declares `reportSchema`, a non-failure report
 * missing a required top-level key is a structural refusal that names
 * that field (same class as missing `ok` type) — the schema is judgment
 * declared on the task, never inferred from filesystem or git.
 */

import { missingReportSchemaField } from "./task-contract-decision";

export type ReportRetryLinkedTask = {
  /** Há implementer VIVO nesta task agora (`hasLiveImplementer`) — o
   * segundo fato, perguntado pelo nome. Não é `status`. */
  inParticipation: boolean;
  retry_count: number;
  max_retries: number | null;
  /** Declared required top-level keys on the task (`tasks.report_schema_json`). */
  reportSchema?: string[] | null;
};

export type ReportRetryDecision =
  | { action: "structural"; field: string; error: string }
  | { action: "refuse_retryable"; retryCount: number; retriesRemaining: number; error: string }
  | { action: "accept_failure"; terminal: boolean }
  | { action: "accept" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `report` is an untyped argument on the MCP surface (`mcp-server.ts`
 * declares it `z.unknown()`), so a client/model can hand the payload as
 * a JSON **string** (`'{"ok":true}'`) instead of an object. Measured
 * 2026-09-15 in the opencode session store: the SAME agent sent `report`
 * as an object on one call and as a JSON string on the next, so this is
 * not a deterministic client bug — it is the price of an untyped field.
 *
 * A JSON-encoded object carries exactly the same value as the object, so
 * decode it; anything else (prose, number, array, malformed JSON, a JSON
 * array) is returned untouched and handled as before. Narrow by design:
 * a bare free-form string is a legal report on its own and must NOT be
 * reinterpreted.
 */
export function decodeReportArgument(report: unknown): unknown {
  if (typeof report !== "string") return report;
  const trimmed = report.trim();
  if (trimmed[0] !== "{") return report;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isPlainObject(parsed) ? parsed : report;
  } catch {
    return report;
  }
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
 * A declared reportSchema key that is absent from the payload. This is a
 * DIFFERENT fact from `describeStructuralReportError`'s type error: `ok`
 * missing is not `ok` mistyped. Reusing the type message here made
 * `{ok: true, ...}`-less payloads answer "report.ok must be a boolean"
 * (measured live 2026-09-15) — again blaming the agent for a value it
 * never supplied. Name the missing key; never claim a type problem.
 */
export function describeMissingReportField(field: string): string {
  return `missing ${field} (required by the task's reportSchema)`;
}

/**
 * A payload that is not a JSON object still has to satisfy a declared
 * reportSchema. Naming `schema[0]` here produced "report.ok must be a
 * boolean" for a JSON *string* envelope — a message that blamed a key
 * the agent had supplied correctly inside the string. Name the envelope
 * instead, and say which keys the object must carry.
 */
export function describeNonObjectReportError(report: unknown, schema: string[] | null | undefined): string {
  const received =
    report === null
      ? "null"
      : Array.isArray(report)
        ? "an array"
        : typeof report === "string"
          ? "a string"
          : `a ${typeof report}`;
  const keys = schema && schema.length > 0 ? ` Required keys: ${schema.join(", ")}.` : "";
  const hint = typeof report === "string" ? " Send the object itself, not a JSON-encoded string." : " Send a JSON object.";
  return `report must be a JSON object (received ${received}).${keys}${hint}`;
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

  // Normalise a JSON-encoded object envelope before judging the payload
  // (`decodeReportArgument`). Applied here as well as at the MCP boundary
  // so a decision reached from any caller sees the same value.
  const report = decodeReportArgument(input.report);

  if (!isPlainObject(report)) {
    // A non-object cannot satisfy a declared key list. Name the ENVELOPE,
    // never `schema[0]` — a JSON string contains `ok` perfectly well and
    // must not be answered with "report.ok must be a boolean".
    const schema = input.linkedTask?.reportSchema;
    const missing = missingReportSchemaField(report, schema);
    if (missing) {
      return { action: "structural", field: "report", error: describeNonObjectReportError(report, schema) };
    }
    return { action: "accept" };
  }

  if ("ok" in report && typeof report.ok !== "boolean") {
    return { action: "structural", field: "ok", error: describeStructuralReportError("ok") };
  }
  if ("retryable" in report && typeof report.retryable !== "boolean") {
    return { action: "structural", field: "retryable", error: describeStructuralReportError("retryable") };
  }

  // Declared failure skips reportSchema — the agent is saying it cannot
  // deliver the contract yet (retryable) or at all (terminal). Success /
  // omitted-ok must name every declared field.
  if (report.ok !== false) {
    const missing = missingReportSchemaField(report, input.linkedTask?.reportSchema);
    if (missing) {
      return { action: "structural", field: missing, error: describeMissingReportField(missing) };
    }
    return { action: "accept" };
  }

  const terminal = report.retryable === false;
  if (terminal) {
    return { action: "accept_failure", terminal: true };
  }

  const task = input.linkedTask;
  if (!task || !task.inParticipation) {
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
