/**
 * Import from a local board — pure helpers. The wizard reads the open tasks of
 * the chosen local boards through the existing store bridges, maps each one to
 * a row of the team's "json" import and sends them in batches. Nothing here
 * touches the network or the store.
 */

import type { TaskPurpose } from "../../task-purpose";

/** Rows per import job: the API creates at most this many per run. */
export const LOCAL_IMPORT_BATCH_SIZE = 200;

/** Only open tasks go: the API creates every imported task as open. */
const OPEN_STATUSES: readonly string[] = ["pending", "blocked"];

const TITLE_MAX_CHARS = 200;

export function isOpenLocalStatus(status: string): boolean {
  return OPEN_STATUSES.includes(status);
}

export type LocalBoardSummary = {
  id: string;
  name: string;
  pending: number;
  blocked: number;
  /** Done, failed, superseded and any other non-open status. */
  other: number;
};

export function summarizeLocalBoard(board: { id: string; name: string }, tasks: readonly { status: string }[]): LocalBoardSummary {
  let pending = 0;
  let blocked = 0;
  let other = 0;
  for (const task of tasks) {
    if (task.status === "pending") pending += 1;
    else if (task.status === "blocked") blocked += 1;
    else other += 1;
  }
  return { id: board.id, name: board.name, pending, blocked, other };
}

export function openCount(summary: Pick<LocalBoardSummary, "pending" | "blocked">): number {
  return summary.pending + summary.blocked;
}

export function totalOpen(summaries: readonly LocalBoardSummary[], selected: ReadonlySet<string>): number {
  return summaries.filter((s) => selected.has(s.id)).reduce((sum, s) => sum + openCount(s), 0);
}

export function totalOutOfScope(summaries: readonly LocalBoardSummary[], selected: ReadonlySet<string>): number {
  return summaries.filter((s) => selected.has(s.id)).reduce((sum, s) => sum + s.other, 0);
}

/** First non-blank line of the prompt, capped at 200 characters ("" if none). */
export function localTaskTitle(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) return "";
  return Array.from(line).slice(0, TITLE_MAX_CHARS).join("");
}

const KIND_BY_PURPOSE: Record<TaskPurpose, string> = {
  implement: "implementar",
  fix: "corrigir",
  investigate: "investigar",
  integrate: "integrar",
  measure: "medir",
};

/** Team task kind for a local purpose; no purpose means "implementar". */
export function localTaskKind(purpose: string | null | undefined): string {
  if (purpose && Object.prototype.hasOwnProperty.call(KIND_BY_PURPOSE, purpose)) return KIND_BY_PURPOSE[purpose as TaskPurpose];
  return "implementar";
}

export type LocalImportSource = {
  id: string;
  boardName: string;
  prompt: string;
  purpose: string | null;
};

export type LocalImportRow = {
  title: string;
  contract: string;
  kind: string;
  priority: "media";
  external_id: string;
};

/** The id carried to the team: re-importing the same local task is a no-op. */
export function localExternalId(taskId: string): string {
  return `local:${taskId}`;
}

/** null when the prompt has no text: such a task has no title to import. */
export function buildLocalImportRow(source: LocalImportSource): LocalImportRow | null {
  const title = localTaskTitle(source.prompt);
  if (title === "") return null;
  return {
    title,
    contract: source.prompt,
    kind: localTaskKind(source.purpose),
    priority: "media",
    external_id: localExternalId(source.id),
  };
}

export function chunkRows<T>(rows: readonly T[], size: number = LOCAL_IMPORT_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** The field mapping for the "json" import: each column maps to itself. */
export const LOCAL_IMPORT_MAPPING = {
  title: "title",
  kind: "kind",
  priority: "priority",
  contract: "contract",
  external_id: "external_id",
} as const;

export function localImportBody(rows: readonly LocalImportRow[]): Record<string, unknown> {
  return {
    kind: "json",
    rule: { channel: "", reaction: "", limit: 0 },
    mapping: { ...LOCAL_IMPORT_MAPPING },
    data: JSON.stringify(rows),
    continue: false,
  };
}

export type LocalPreviewTotals = { total: number; duplicates: number };

export function addPreviewTotals(a: LocalPreviewTotals, b: LocalPreviewTotals): LocalPreviewTotals {
  return { total: a.total + b.total, duplicates: a.duplicates + b.duplicates };
}

export function newTaskCount(totals: LocalPreviewTotals): number {
  return Math.max(0, totals.total - totals.duplicates);
}

export type LocalBatchState = {
  /** Lines in this batch. */
  lines: number;
  status: "pending" | "running" | "done" | "failed";
  created: number;
  skipped: number;
  error: string | null;
};

export function initialBatches(totalRows: number, size: number = LOCAL_IMPORT_BATCH_SIZE): LocalBatchState[] {
  const batches: LocalBatchState[] = [];
  for (let left = totalRows; left > 0; left -= size) {
    batches.push({ lines: Math.min(size, left), status: "pending", created: 0, skipped: 0, error: null });
  }
  return batches;
}

export function processedLines(batches: readonly LocalBatchState[]): number {
  return batches.filter((b) => b.status === "done" || b.status === "failed").reduce((sum, b) => sum + b.lines, 0);
}

export function totalLines(batches: readonly LocalBatchState[]): number {
  return batches.reduce((sum, b) => sum + b.lines, 0);
}

export type LocalImportOutcome = {
  created: number;
  skipped: number;
  /** Lines of the failed batch plus every batch not sent. */
  notImported: number;
  batchesDone: number;
  batchesTotal: number;
  stopped: boolean;
  error: string | null;
};

export function summarizeBatches(batches: readonly LocalBatchState[], stopped: boolean): LocalImportOutcome {
  const done = batches.filter((b) => b.status === "done");
  const failed = batches.find((b) => b.status === "failed");
  return {
    created: done.reduce((sum, b) => sum + b.created, 0),
    skipped: done.reduce((sum, b) => sum + b.skipped, 0),
    notImported: batches.filter((b) => b.status === "failed" || b.status === "pending").reduce((sum, b) => sum + b.lines, 0),
    batchesDone: done.length,
    batchesTotal: batches.length,
    stopped,
    error: failed?.error ?? null,
  };
}

export type LocalSampleItem = { title: string; externalId: string; duplicate: boolean; existingRef: string | null };

/** A short sample for the preview: up to 3 new rows, then up to 2 already-present ones. */
export function pickSample(items: readonly LocalSampleItem[]): LocalSampleItem[] {
  const fresh = items.filter((i) => !i.duplicate).slice(0, 3);
  const dup = items.filter((i) => i.duplicate).slice(0, 2);
  return [...fresh, ...dup];
}
