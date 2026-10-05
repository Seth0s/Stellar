/**
 * The gate MESSAGES that reach the orchestrator and the gateRun summary the
 * Fila draws. Pure: no I/O, no clock, no state.
 *
 * The defect: the "gates measured by the app: N/M …" notice arrived as a
 * STANDALONE message — no task id, after the report notice, and a green never
 * changed a decision. The fix puts the result on the SAME line as the report
 * notice, stays silent on green, and speaks alone only on a CONTRADICTION: a
 * report that declares success while the app-measured gates failed (or the
 * opposite) is the one piece the orchestrator must see without digging.
 *
 * The result itself still lives on the task (`result_json.gateRun`), read by
 * `read_report` and `get_task` — this module only builds the message and the
 * slice the Fila renders.
 */

import type { GateRunEvidence } from "./gate-runner";
import { gateRunSummaryFromResult, type GateRunSummary } from "./list-tasks-query";
import { shortTaskId } from "./task-id-prefix-decision";

/**
 * Ceiling for the report notice to wait on the gates. Past it the notice goes
 * out with "gates ainda rodando" and the result stays on the task. The value
 * is DECLARED, not "the gate's duration": it is how long a line is worth
 * waiting for. A long suite (or the turn in the repo lock) must not hold the
 * report pointer for minutes.
 */
export const GATE_NOTICE_WAIT_MS = 90_000;

/** How many trailing output lines the contradiction message carries. */
export const GATE_CONTRADICTION_TAIL_LINES = 10;

/** The gateRun summary from the in-memory evidence — same read that
 * `read_report`/`get_task` do from the stamped row, without re-reading it. */
export function gateRunSummaryFromEvidence(evidence: GateRunEvidence): GateRunSummary {
  return (
    gateRunSummaryFromResult({ gateRun: evidence }) ?? {
      ok: evidence.ok === true,
      passed: evidence.commands.filter((c) => c.exitCode === 0).length,
      total: evidence.commands.length,
      failedCommand: null,
    }
  );
}

/** The suffix the report notice carries on the SAME line. `null` = the gates
 * did not finish within the ceiling (the result stays on the task). */
export function describeGateResultSuffix(summary: GateRunSummary | null): string {
  if (!summary) return " — gates ainda rodando";
  const failed = summary.ok ? "" : ` — failed: ${summary.failedCommand ?? "?"}`;
  return ` — gates ${summary.passed}/${summary.total}${failed}`;
}

/** Where the gate was measured, in short prose, for the contradiction message.
 * No isolation evidence = shared (the behaviour before isolation existed). */
export function describeGateIsolationMode(
  isolation: { mode: "isolated" | "shared"; reason: string | null; undeclaredInTerritory?: readonly string[] } | null | undefined,
): string {
  if (!isolation || isolation.mode === "shared") {
    const why = isolation?.reason ? ` (${isolation.reason})` : "";
    return `shared tree — may include other cards' work${why}`;
  }
  const undeclared = isolation.undeclaredInTerritory ?? [];
  const extra =
    undeclared.length > 0
      ? `; ${undeclared.length} file(s) of the territory not declared entered the gate (${undeclared.join(", ")})`
      : "";
  return `isolated worktree — only this task's changes${extra}`;
}

/** The last `n` non-empty lines of a text, so it fits in a message. */
export function lastNonEmptyLines(text: string | null | undefined, n: number): string {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** The trailing output of a failed command: stdout and stderr joined; the
 * informative part is the END (same reasoning as the gate's `TailCollector`). */
function failingCommandOutput(evidence: GateRunEvidence): string | null {
  const failed = evidence.commands.find((c) => c.exitCode !== 0) ?? evidence.commands[evidence.commands.length - 1];
  if (!failed) return null;
  const combined = [failed.stdout, failed.stderr].filter((s) => s && s.trim().length > 0).join("\n");
  const tail = lastNonEmptyLines(combined, GATE_CONTRADICTION_TAIL_LINES);
  return tail.length > 0 ? tail : null;
}

/**
 * The CONTRADICTION — the ONLY self-standing message. `null` when report and
 * gate agree (success+green, or failure+red): there the result already
 * travels on the report-notice line, and a second message would be noise.
 *
 * Both directions are the same defect: a report declaring success with red
 * gates (shipped what does not pass), or declaring failure with green gates
 * (the problem was something else). The text names the failing command and
 * the mode the gate was measured in, so a green/red is never read as if it
 * were this task's alone when it is not.
 */
export function describeGateContradiction(input: {
  taskId: string;
  title: string;
  /** `report.ok !== false` — what the report DECLARED. */
  reportOk: boolean;
  evidence: GateRunEvidence;
}): string | null {
  const summary = gateRunSummaryFromEvidence(input.evidence);
  if (summary.ok === input.reportOk) return null;
  const short = shortTaskId(input.taskId);
  const direction = input.reportOk
    ? "the report declared SUCCESS (ok:true) but the app-measured gates FAILED"
    : "the report declared FAILURE (ok:false) but the app-measured gates PASSED";
  const verdict =
    summary.passed === summary.total
      ? `${summary.passed}/${summary.total} passed`
      : `${summary.passed}/${summary.total} passed, failed: ${summary.failedCommand ?? "?"}`;
  const title = input.title ? ` ("${input.title}")` : "";
  const first =
    `[de: stellar] gate contradiction — task ${short}${title}: ${direction} ` +
    `(${verdict}). Mode: ${describeGateIsolationMode(input.evidence.isolation)}.`;
  const outputTail = failingCommandOutput(input.evidence);
  if (!outputTail) return first;
  return `${first}\nLast output:\n${outputTail}`;
}

/** The gateRun slice the Fila chip draws. Deliberately compact: no diff patch
 * and no full output, just what the verdict, the mode and the trailing output
 * loaded into the tooltip need. */
export type TaskGateIsolationView = {
  mode: "isolated" | "shared";
  reason: string | null;
  undeclaredInTerritory: string[];
};

export type TaskGateView = {
  ok: boolean;
  passed: number;
  total: number;
  failedCommand: string | null;
  isolation: TaskGateIsolationView | null;
  /** Trailing output of the failed command, for the tooltip/expansion. */
  failedOutput: string | null;
};

function asIsolation(value: unknown): TaskGateIsolationView | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const mode = v.mode === "isolated" ? "isolated" : v.mode === "shared" ? "shared" : null;
  if (mode === null) return null;
  const undeclared = Array.isArray(v.undeclaredInTerritory)
    ? v.undeclaredInTerritory.filter((p): p is string => typeof p === "string")
    : [];
  return { mode, reason: typeof v.reason === "string" ? v.reason : null, undeclaredInTerritory: undeclared };
}

/**
 * Extract the `result_json.gateRun` slice for the Fila. PURE and defensive:
 * old row, broken JSON, missing `gateRun`/`commands` → `null` (the UI simply
 * does not draw the chip). It never judges the content — the verdict is the
 * exit code, as everywhere else in the runner.
 */
export function taskGateViewFromResult(resultJson: string | null | undefined): TaskGateView | null {
  if (!resultJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    return null;
  }
  const summary = gateRunSummaryFromResult(parsed);
  if (!summary) return null;
  const gateRun = (parsed as Record<string, unknown>).gateRun as Record<string, unknown> | undefined;
  const commands = gateRun?.commands;
  const failed = Array.isArray(commands)
    ? (commands.find((c) => typeof c === "object" && c !== null && (c as Record<string, unknown>).exitCode !== 0) as
        | Record<string, unknown>
        | undefined)
    : undefined;
  const combined =
    failed && typeof failed === "object"
      ? [failed.stdout, failed.stderr].filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n")
      : "";
  const failedOutput = lastNonEmptyLines(combined, GATE_CONTRADICTION_TAIL_LINES);
  return {
    ok: summary.ok,
    passed: summary.passed,
    total: summary.total,
    failedCommand: summary.failedCommand,
    isolation: asIsolation(gateRun?.isolation),
    failedOutput: failedOutput.length > 0 ? failedOutput : null,
  };
}
