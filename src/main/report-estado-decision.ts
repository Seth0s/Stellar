/**
 * Report ESTADO — parcial vs final — and the cheap intention checkpoint.
 *
 * WHY THIS MODULE EXISTS: `reports` is already append-only by `seq`. Cards
 * already file many reports. What was missing is the CONTRACT: a report is
 * not a terminal event. Absence of an `estado` field must NEVER mean
 * "finished" — measured on the live board, ~99.9% of existing object
 * reports have no `estado`, so treating absence as final would silently
 * relabel almost every historical row as complete.
 *
 * WHO MARKS FINAL: only the agent. The app never invents `final` from
 * gates, idle, exit, or ok:true. A card that dies before writing final
 * correctly leaves the last row as parcial.
 *
 * SEALS (same ladder language as `diff-attribution.ts`, not a new vocab):
 *   - DECLARADO — agent-authored: `estado`, `decisaoTomada`, `oQueNaoFiz`.
 *   - MEDIDO — app-authored facts that do not need the agent to survive:
 *     gate `exit_code`, timestamps, commands the app ran (`gateRun`).
 * The UI must not mix the two seals (same discipline as DISPUTADO vs JANELA).
 *
 * INTENTION WINDOW (declared limit, not a bug to close here): a checkpoint
 * still depends on the agent typing one phrase. Dying between deciding and
 * writing that phrase still loses it — this contract shrinks the window
 * from "the whole turn" to "one sentence"; it does not close it.
 */

export type ReportEstado = "parcial" | "final";

/** Seal labels — English agent-facing, matching attribution vocabulary. */
export const REPORT_SEAL_MEDIDO = "MEDIDO" as const;
export const REPORT_SEAL_DECLARADO = "DECLARADO" as const;

/**
 * AGENT-FACING — English only. Shared by the MCP `report` tool description,
 * ACBRIDGE_HINT, and the scrollback discovery tip so every channel names the
 * same contract. Absence of `estado` is parcial. close_card never concludes
 * a task — estado final is the agent's own checkpoint seal, not a done stamp.
 */
export const REPORT_ESTADO_AGENT_HINT =
  'Put estado: "parcial" | "final" in the report JSON (omit = parcial — never finished). ' +
  "Only you mark final; the app never invents it. Declare decisaoTomada as soon as you decide " +
  "(one or two sentences) — do not wait until the end.";

/**
 * Measured on the live board: median `filesChanged` length per object
 * report ≈ 4; p90 ≈ 11. Reminder threshold = 2× median so a typical mid-
 * work report is not nagged, but a long write streak without a phrase is.
 * Too-early reminders become ignored noise — worse than none.
 */
export const CHECKPOINT_WRITE_THRESHOLD = 8;

export function normalizeReportEstado(report: unknown): ReportEstado {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return "parcial";
  const raw = (report as Record<string, unknown>).estado;
  if (typeof raw !== "string") return "parcial";
  const v = raw.trim().toLowerCase();
  if (v === "final") return "final";
  // Anything else — including explicit "parcial", typos, unknowns — is parcial.
  return "parcial";
}

/** True only when the agent explicitly marked the round finished. */
export function isFinalReport(report: unknown): boolean {
  return normalizeReportEstado(report) === "final";
}

/**
 * Evidence that the agent marked this report as a finished round
 * (ok:true + estado final). Used for leave-gates (implementer self-close)
 * and read helpers — NOT as a close_card done stamp (close never concludes).
 */
export function reportConcludesTask(report: unknown): boolean {
  if (!isFinalReport(report)) return false;
  if (report === null || typeof report !== "object" || Array.isArray(report)) return false;
  return (report as { ok?: unknown }).ok === true;
}

/** Agent-authored intention phrase present? (checkpoint clear condition). */
export function reportDeclaresIntention(report: unknown): boolean {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return false;
  const body = report as Record<string, unknown>;
  for (const key of ["decisaoTomada", "decision"] as const) {
    const v = body[key];
    if (typeof v === "string" && v.trim().length > 0) return true;
  }
  return false;
}

/**
 * Latest final seq in an ordered history, if any. Pure helper for get_report
 * so a newer parcial does not hide that a final already exists.
 */
export function latestFinalSeq(
  history: readonly { seq: number; report: unknown }[],
): number | null {
  let found: number | null = null;
  for (const row of history) {
    if (isFinalReport(row.report)) found = row.seq;
  }
  return found;
}

export type CheckpointReminderDecision =
  | { action: "silent" }
  | { action: "remind"; writesSinceCheckpoint: number; threshold: number };

/**
 * Cheap nudge: after N observed writes without an intention checkpoint,
 * ask for one sentence. Does not interrupt work. Fires once per streak
 * (`alreadyNotified`); a later checkpoint clears the streak.
 */
export function decideCheckpointReminder(input: {
  writesSinceCheckpoint: number;
  threshold?: number;
  alreadyNotified: boolean;
}): CheckpointReminderDecision {
  const threshold = input.threshold ?? CHECKPOINT_WRITE_THRESHOLD;
  if (input.alreadyNotified) return { action: "silent" };
  if (input.writesSinceCheckpoint < threshold) return { action: "silent" };
  return {
    action: "remind",
    writesSinceCheckpoint: input.writesSinceCheckpoint,
    threshold,
  };
}
