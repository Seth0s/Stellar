/**
 * Human create-task with the full MCP create_task contract (purpose,
 * territory, gates, reportSchema, allowCommit, review, provider, deps,
 * maxRetries, fallbackProviders, cwd). Lives outside index.ts so another
 * card can keep owning that file — register from index with one call.
 */

import { randomUUID } from "node:crypto";
import type { IpcMain } from "electron";
import {
  allowCommitToSql,
  gatesToSql,
  parseTaskContractInput,
  reportSchemaToSql,
  territoryToSql,
} from "./task-contract-decision";
import { normalizeTaskPurpose, normalizeTaskReview, TASK_PURPOSES, TASK_REVIEW_VALUES } from "../task-purpose";
import type { TaskRow } from "./store";

export const CREATE_TASK_FULL_CHANNEL = "store:tasks:create-full";

export type CreateTaskFullInput = {
  boardId: string;
  prompt: string;
  purpose?: string | null;
  territory?: string[] | null;
  gates?: unknown;
  reportSchema?: string[] | null;
  allowCommit?: boolean | null;
  review?: string | null;
  provider?: string | null;
  deps?: string[] | null;
  maxRetries?: number | null;
  fallbackProviders?: string[] | null;
  cwd?: string | null;
  suggestedOrder?: number | null;
  spawnProfile?: string | null;
};

export type CreateTaskFullResult =
  | { ok: true; taskId: string }
  | { ok: false; error: string; field?: string };

export type CreateTaskIpcDeps = {
  boardExists: (boardId: string) => boolean;
  upsertTask: (row: TaskRow) => unknown;
};

export function createTaskFull(input: CreateTaskFullInput, deps: CreateTaskIpcDeps): CreateTaskFullResult {
  const boardId = typeof input.boardId === "string" ? input.boardId.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "empty prompt", field: "prompt" };
  if (!boardId || !deps.boardExists(boardId)) {
    return { ok: false, error: `no such board "${boardId}"`, field: "boardId" };
  }
  if (input.purpose !== undefined && input.purpose !== null && normalizeTaskPurpose(input.purpose) === null) {
    return {
      ok: false,
      error: `purpose must be one of ${TASK_PURPOSES.map((p) => `"${p}"`).join(", ")}, got "${String(input.purpose)}"`,
      field: "purpose",
    };
  }
  if (input.review !== undefined && input.review !== null && normalizeTaskReview(input.review) === null) {
    return {
      ok: false,
      error: `review must be ${TASK_REVIEW_VALUES.map((v) => `"${v}"`).join(" or ")} (or null), got "${String(input.review)}"`,
      field: "review",
    };
  }
  const contractParse = parseTaskContractInput({
    territory: input.territory ?? undefined,
    gates: input.gates ?? undefined,
    allowCommit: input.allowCommit ?? undefined,
    reportSchema: input.reportSchema ?? undefined,
  });
  if (!contractParse.ok) {
    return { ok: false, error: contractParse.error, field: contractParse.field };
  }
  const now = Date.now();
  const id = randomUUID();
  const depsList = Array.isArray(input.deps) ? input.deps.filter((d) => typeof d === "string" && d.trim()) : [];
  const fallback = Array.isArray(input.fallbackProviders)
    ? input.fallbackProviders.filter((p) => typeof p === "string" && p.trim())
    : [];
  const row: TaskRow = {
    id,
    prompt,
    provider: typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : null,
    status: "pending",
    card_id: null,
    spawn_profile: typeof input.spawnProfile === "string" && input.spawnProfile.trim() ? input.spawnProfile.trim() : null,
    board_id: boardId,
    cwd: typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : null,
    result_json: null,
    deps_json: depsList.length > 0 ? JSON.stringify(depsList) : null,
    purpose: input.purpose !== undefined && input.purpose !== null ? normalizeTaskPurpose(input.purpose) : null,
    review: input.review !== undefined && input.review !== null ? normalizeTaskReview(input.review) : null,
    territory_json: territoryToSql(contractParse.contract.territory),
    gates_json: gatesToSql(contractParse.contract.gates),
    allow_commit: allowCommitToSql(contractParse.contract.allowCommit),
    report_schema_json: reportSchemaToSql(contractParse.contract.reportSchema),
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: typeof input.maxRetries === "number" && Number.isFinite(input.maxRetries) ? input.maxRetries : null,
    fallback_providers_json: fallback.length > 0 ? JSON.stringify(fallback) : null,
    order: null,
    suggested_order: typeof input.suggestedOrder === "number" ? input.suggestedOrder : null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: now,
    updated_at: now,
    actor: "human",
  } as TaskRow;
  deps.upsertTask(row);
  return { ok: true, taskId: id };
}

/** One call from index.ts: `registerCreateTaskIpc(ipcMain, { boardExists, upsertTask })`. */
export function registerCreateTaskIpc(ipcMain: IpcMain, deps: CreateTaskIpcDeps): void {
  ipcMain.handle(CREATE_TASK_FULL_CHANNEL, (_e, raw: CreateTaskFullInput) => createTaskFull(raw ?? ({} as CreateTaskFullInput), deps));
}
