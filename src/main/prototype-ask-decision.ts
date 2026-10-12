/**
 * PROTOTYPE TO APPROVE — the explicit signal, decided in one place.
 *
 * The Fila used to read "a prototype is waiting for the owner" off
 * `review === "wanted"` with no reviewer card, which measures a missing
 * reviewer, not a prototype. The signal is now declared by the agent: a
 * `parcial` report that names the prototype file and asks for approval:
 *
 *     { "estado": "parcial", "taskId": "<task>",
 *       "prototype": { "path": "settings.dc.html", "approval": "requested" } }
 *
 * `path` is relative to the board's `prototypes/` directory (a leading
 * `prototypes/` is tolerated). The ask is DERIVED from the reports on read, so
 * there is no second place to keep in sync; the owner's approval is the only
 * thing stored, on the task, keyed by the report time it answers.
 *
 * Approving a prototype does not approve the task: it only releases the next
 * phase of the work. Pure functions, no I/O.
 */

import { declaredTaskIdFromReportBody } from "./report-task-link-decision";
import { isFinalReport, reportConcludesTask } from "./report-estado-decision";
import type { PhaseReportRow } from "./task-phase-decision";

/** Key of the owner's approval inside the task's `result_json`. */
export const PROTOTYPE_APPROVAL_KEY = "prototypeApproval";

/** A prototype that is waiting for the owner. `askedAt` is the report's time. */
export type PrototypeAsk = { path: string; askedAt: number };

/** The owner's answer to one ask. */
export type PrototypeApproval = { path: string; askedAt: number; approvedAt: number };

const TERMINAL_PHASES: ReadonlySet<string> = new Set(["done", "failed", "superseded"]);
const MAX_PATH = 256;

/**
 * The path as the prototype server will take it, or `null` when it is not a
 * plain relative HTML file name. A leading `prototypes/` is dropped. Nothing
 * absolute, nothing that climbs, no URL, no backslash, no control character.
 */
export function safePrototypePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let path = raw.trim();
  if (path.startsWith("prototypes/")) path = path.slice("prototypes/".length);
  if (path === "" || path.length > MAX_PATH) return null;
  if (path.startsWith("/") || path.startsWith("~") || path.includes("\\") || path.includes("://"))
    return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return null;
  if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === ""))
    return null;
  if (!/\.html?$/i.test(path)) return null;
  return path;
}

/** `{ path, approval: "requested" }` declared in a report body, or `null`. */
function declaredPrototype(body: unknown): { path: string | null; approval: string } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const proto = (body as Record<string, unknown>).prototype;
  if (proto === null || typeof proto !== "object" || Array.isArray(proto)) return null;
  const record = proto as Record<string, unknown>;
  return {
    path: safePrototypePath(record.path),
    approval: typeof record.approval === "string" ? record.approval : "",
  };
}

/**
 * The prototype waiting for the owner on this task, or `null`.
 *
 * The NEWEST report of the task that declares a `prototype` decides: it must
 * ask for approval with a usable path and must not be a final report. The ask
 * is off when the task already ended, when a later report concluded the task,
 * or when the owner already approved exactly this ask.
 */
export function derivePrototypeAsk(input: {
  taskId: string;
  phase: string;
  reports: readonly PhaseReportRow[];
  approval: PrototypeApproval | null;
}): PrototypeAsk | null {
  if (TERMINAL_PHASES.has(input.phase)) return null;
  let newest: { row: PhaseReportRow; proto: { path: string | null; approval: string } } | null =
    null;
  let concludedAt: number | null = null;
  for (const row of input.reports) {
    if (declaredTaskIdFromReportBody(row.body) !== input.taskId) continue;
    if (reportConcludesTask(row.body) && (concludedAt === null || row.at >= concludedAt))
      concludedAt = row.at;
    const proto = declaredPrototype(row.body);
    if (!proto) continue;
    if (newest === null || row.at >= newest.row.at) newest = { row, proto };
  }
  if (newest === null) return null;
  if (newest.proto.approval !== "requested" || newest.proto.path === null) return null;
  if (isFinalReport(newest.row.body)) return null;
  if (concludedAt !== null && concludedAt >= newest.row.at) return null;
  const ask: PrototypeAsk = { path: newest.proto.path, askedAt: newest.row.at };
  if (input.approval && input.approval.askedAt === ask.askedAt && input.approval.path === ask.path)
    return null;
  return ask;
}

function parseObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return { _raw: json };
  } catch {
    return { _raw: json };
  }
}

/** The stored approval, `null` when there is none (or it is not well formed). */
export function prototypeApprovalFromResultJson(
  json: string | null | undefined,
): PrototypeApproval | null {
  if (!json || !json.includes(`"${PROTOTYPE_APPROVAL_KEY}"`)) return null;
  const raw = parseObject(json)[PROTOTYPE_APPROVAL_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const path = safePrototypePath(record.path);
  if (path === null) return null;
  if (typeof record.askedAt !== "number" || typeof record.approvedAt !== "number") return null;
  return { path, askedAt: record.askedAt, approvedAt: record.approvedAt };
}

/** `result_json` with the approval stamped; every other key is kept. */
export function stampPrototypeApprovalJson(
  existingJson: string | null | undefined,
  approval: PrototypeApproval,
): string {
  const base = parseObject(existingJson);
  base[PROTOTYPE_APPROVAL_KEY] = approval;
  return JSON.stringify(base);
}
