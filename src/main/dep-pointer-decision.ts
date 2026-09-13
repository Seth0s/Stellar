/**
 * Pure decision for the parent POINTER a dependent task's brief carries.
 *
 * Measured 2026-09-13 (second-opinion review of 3 real `deps` chains):
 * the child's hand-written prompt was CONTAINED in the parent's report
 * in 3/3 cases, near-verbatim in one, and in 1/3 the rewrite LOST data
 * the report had. The child already has `get_task` / `read_report` and
 * simply is not told it has a parent — the stored prompt is static text
 * and nothing injected the reference. This module derives that reference
 * from the real `deps_json` ids, never from prose.
 *
 * Pointer, not content. Three reasons, all measured against the live DB:
 *  - Reports are big: 106 rows, avg 3 069 chars, max 14 830, and the
 *    last 20 span 568–13 318. The brief is TYPED into a PTY whenever the
 *    provider cannot take it on argv (`dispatchSpawnAgentRequest`), so a
 *    pasted report is seconds of keystrokes per parent, times N parents,
 *    and it lands in the agent's context whether or not it needs it.
 *  - The report row keeps evolving (append-only `seq`); a copy in the
 *    brief would freeze whatever existed at dispatch and become the
 *    second source of truth spawn-brief-decision.ts exists to remove.
 *  - The pointer costs ~150 chars per parent and the child pays the
 *    read only when it decides to.
 *
 * Brief, not an env var. `AGENT_CANVAS_TASK_ID` (card-spawn-env-
 * decision.ts) is read by acbridge to stamp `taskId` on reports — no
 * agent ever reads it as an instruction, and the gap being fixed is
 * exactly "the child does not KNOW it should look". An env var would be
 * one more fact nobody reads; a line in the brief is the instruction.
 * Also, `deps_json` already reaches the child through
 * `get_task($AGENT_CANVAS_TASK_ID)` — the data is not missing, the
 * nudge is.
 *
 * The pointer never points at a void without saying so. Per parent it
 * states what is actually on file at dispatch time: `done` + report ok,
 * report `ok:false`, a verdict when one was given (column or, for pre-
 * promotion acbridge rows, inside the JSON), or NO report at all — the
 * 2026-09-13 DB has 13/85 done tasks whose linked cards never reported
 * (human "concluir" button, exit without `report`). The child is told to
 * verify such a parent's work itself instead of trusting a report that
 * does not exist. It also lists the card ids that carry a report so the
 * child can call `read_report` without a `get_task` round-trip.
 */

export type DepReportSummary = {
  cardId: string;
  /** `report.ok` when it is a boolean, else undefined (malformed body). */
  ok: boolean | undefined;
  /** Typed `reports.verdict` column, else `report.verdict` in the body. */
  verdict: string | null;
};

export type DepPointerSource = {
  id: string;
  /** `null` when the id in `deps_json` matches no task row. */
  status: string | null;
  /** Latest report per linked card, most recent card first. Empty when
   * no linked card ever reported. */
  reports: DepReportSummary[];
};

export const DEP_POINTER_MARKER = "[stellar:deps]";

function describeDep(dep: DepPointerSource): string {
  if (dep.status === null) return `- ${dep.id} — task not found (id in deps_json matches no task); ask the orchestrator before relying on it`;
  const state = `status ${dep.status}`;
  if (dep.reports.length === 0) {
    return `- ${dep.id} — ${state}, NO report on file (closed by button or exited without calling report): verify its work yourself, do not assume it landed`;
  }
  const parts = dep.reports.map((r) => {
    const okText = r.ok === true ? "ok" : r.ok === false ? "ok:false (FAILED — read why before building on it)" : "ok unknown";
    const verdictText = r.verdict ? `, verdict ${r.verdict}` : "";
    return `card ${r.cardId}: ${okText}${verdictText}`;
  });
  return `- ${dep.id} — ${state}; read_report on ${parts.join("; ")}`;
}

/** The pointer block for a non-empty deps list; `undefined` for an empty
 * one so a task without deps leaves the brief byte-identical (regression
 * the tests pin). */
export function buildDepPointer(deps: DepPointerSource[]): string | undefined {
  if (deps.length === 0) return undefined;
  const noun = deps.length === 1 ? "parent task" : "parent tasks";
  const header =
    `${DEP_POINTER_MARKER} This task depends on ${deps.length} ${noun}. ` +
    `Before starting, call get_task on each id and read_report on the listed card(s) ` +
    `(MCP tools, or \`acbridge get-task <id>\` / \`acbridge read-report <cardId>\`) — ` +
    `the parent's report is the primary source for this task; the text above may paraphrase or omit parts of it.`;
  return [header, ...deps.map(describeDep)].join("\n");
}

/** Appends the pointer below the delivered brief. Empty deps → the brief
 * exactly as given (including `undefined`). A task with deps but no
 * prompt still gets the pointer: the child would otherwise open mute
 * AND parentless, and the pointer is derived from stored facts, not an
 * invented prompt. */
export function appendDepPointer(brief: string | undefined, deps: DepPointerSource[]): string | undefined {
  const pointer = buildDepPointer(deps);
  if (pointer === undefined) return brief;
  return brief ? `${brief}\n\n---\n${pointer}` : pointer;
}

/** Parses `deps_json` into ids; anything non-array or non-string is
 * dropped rather than thrown on — a malformed row must not stop a
 * dispatch that the engine already decided to make. */
export function depIdsFromJson(depsJson: string | null | undefined): string[] {
  if (!depsJson) return [];
  try {
    const parsed: unknown = JSON.parse(depsJson);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string" && d.length > 0) : [];
  } catch {
    return [];
  }
}

/** `report.ok` / `report.verdict` from a stored `report_json`, tolerant
 * of malformed bodies (undefined ok, null verdict). The typed `verdict`
 * column wins when present. */
export function summarizeReport(cardId: string, reportJson: string, verdictColumn: string | null | undefined): DepReportSummary {
  let ok: boolean | undefined;
  let bodyVerdict: string | null = null;
  try {
    const body: unknown = JSON.parse(reportJson);
    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      if (typeof rec.ok === "boolean") ok = rec.ok;
      if (typeof rec.verdict === "string" && rec.verdict.trim()) bodyVerdict = rec.verdict.trim();
    }
  } catch {
    // malformed body: ok stays undefined
  }
  const verdict = verdictColumn && verdictColumn.trim() ? verdictColumn.trim() : bodyVerdict;
  return { cardId, ok, verdict };
}
