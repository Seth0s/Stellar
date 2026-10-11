/**
 * Team import jobs — I/O shell over cloud-api (list/preview/create/run).
 * Polling a running job is the caller's responsibility (renderer or smoke).
 */

import type { CloudApi } from "./cloud-api";
import type { ImportJobView, ImportPreview } from "./import-decision";

export type ImportContext = {
  api: CloudApi;
  token: string;
};

export async function listTeamImports(
  ctx: ImportContext,
  teamId: string,
): Promise<{ ok: true; imports: ImportJobView[] } | { ok: false; error: string }> {
  const res = await ctx.api.listImports(ctx.token, teamId);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, imports: res.value };
}

export async function previewTeamImport(
  ctx: ImportContext,
  teamId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; preview: ImportPreview } | { ok: false; error: string }> {
  const res = await ctx.api.previewImport(ctx.token, teamId, body);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, preview: res.value };
}

export async function createTeamImport(
  ctx: ImportContext,
  teamId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; job: ImportJobView } | { ok: false; error: string }> {
  const res = await ctx.api.createImport(ctx.token, teamId, body);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, job: res.value };
}

export async function runTeamImport(
  ctx: ImportContext,
  teamId: string,
  jobId: string,
): Promise<{ ok: true; job: ImportJobView } | { ok: false; error: string }> {
  const res = await ctx.api.runImport(ctx.token, teamId, jobId);
  if (!res.ok) return { ok: false, error: res.error.message };
  return { ok: true, job: res.value };
}

/**
 * Poll until the job is terminal (done/failed) or attempts are exhausted.
 * Create already runs once; this covers async statuses from a future backend.
 */
export async function awaitImportJob(
  ctx: ImportContext,
  teamId: string,
  jobId: string,
  opts: { sleep: (ms: number) => Promise<void>; maxAttempts?: number; intervalMs?: number } = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
): Promise<{ ok: true; job: ImportJobView } | { ok: false; error: string }> {
  const maxAttempts = opts.maxAttempts ?? 30;
  const intervalMs = opts.intervalMs ?? 200;
  for (let i = 0; i < maxAttempts; i++) {
    const listed = await listTeamImports(ctx, teamId);
    if (!listed.ok) return listed;
    const job = listed.imports.find((j) => j.id === jobId);
    if (!job) return { ok: false, error: "import job not found" };
    if (job.status === "done" || job.status === "failed") return { ok: true, job };
    await opts.sleep(intervalMs);
  }
  return { ok: false, error: "import job still running" };
}
