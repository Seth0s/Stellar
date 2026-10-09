/**
 * The gate MESSAGES that reach the orchestrator and the gateRun summary the
 * Fila draws. Pure: no I/O, no clock, no state.
 *
 * Path attribution separates THIS task's failure from a neighbour's red on a
 * shared tree: parse tsc/vitest/eslint paths, cross with the report's
 * `filesChanged` (+ territory), and classify. A shared-tree red whose errors
 * all sit outside the task's files is `gate_inconclusive` — never a
 * "contradiction". Missing parseable paths are inconclusive too (honest).
 *
 * The result itself still lives on the task (`result_json.gateRun`), read by
 * `read_report` and `get_task` — this module only builds the message and the
 * slice the Fila renders.
 */

import type { GateRunEvidence } from "./gate-runner";
import { isInsideTerritory } from "./gate-runner";
import { normalizeDeclaredRepoPath } from "./gate-isolation-decision";
import { gateRunSummaryFromResult, type GateRunSummary } from "./list-tasks-query";
import { APP_NOTICE } from "./agent-facing-notices";

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

/** Run-level attribution: who the measured red belongs to. */
export type GateAttributionClass = "ok" | "task_failed" | "gate_inconclusive" | "gate_env_error";

export type GateAttribution = {
  class: GateAttributionClass;
  /** Why inconclusive / env — null for ok and plain task_failed. */
  reason: string | null;
  /** Repo-relative paths parsed from failed gate output. */
  errorPaths: string[];
  /** Per-command scores ("cmd 0/1, other 1/1") for the one-line notice. */
  perGate: string;
};

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

/** One score per declared gate — every command ran; the notice names each. */
export function formatPerGateScores(commands: GateRunEvidence["commands"]): string {
  return commands
    .map((c) => {
      const label = c.command.length > 40 ? `${c.command.slice(0, 37)}…` : c.command;
      return `${label} ${c.exitCode === 0 ? "1/1" : "0/1"}`;
    })
    .join(", ");
}

/** ANSI SGR stripper — built from a string so `no-control-regex` stays quiet
 * (same pattern as `session-scrollback.ts`). */
const ANSI_SGR = new RegExp(`\\u001b\\[[0-9;]*m`, "g");

/**
 * Strip ANSI and turn an absolute-or-relative tool path into a repo-relative
 * path, or `null` when it cannot be attributed safely.
 */
export function toRepoRelativeErrorPath(raw: string): string | null {
  let s = raw.replace(ANSI_SGR, "").replace(/\\/g, "/").trim();
  if (!s) return null;
  s = s.replace(/^\.\//, "");
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) {
    const markers = ["/src/", "/tests/", "/scripts/", "/resources/", "/electron/"];
    for (const marker of markers) {
      const i = s.indexOf(marker);
      if (i >= 0) {
        const rel = s.slice(i + 1);
        return normalizeDeclaredRepoPath(rel.split(":")[0] ?? rel);
      }
    }
    return null;
  }
  // Drop trailing :line:col if a matcher captured it with the path.
  s = s.replace(/:\d+(?::\d+)?$/, "");
  return normalizeDeclaredRepoPath(s);
}

/**
 * Parse file paths from tsc / vitest / eslint output. Empty means "no path
 * parseable" — the caller treats that as inconclusive, never as task_failed.
 */
export function parseGateErrorPaths(output: string): string[] {
  const text = output.replace(ANSI_SGR, "");
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const path = toRepoRelativeErrorPath(raw);
    if (!path || seen.has(path)) return;
    seen.add(path);
    found.push(path);
  };

  // tsc: path(line,col): error TS1234:
  for (const m of text.matchAll(/(?:^|[\s"'])([^\s"'()]+?\.[A-Za-z0-9]+)\(\d+,\d+\):\s+error\s+TS\d+/gm)) {
    add(m[1]);
  }
  // vitest: FAIL  path/to/file.test.ts
  for (const m of text.matchAll(/^\s*FAIL\s+(\S+\.[A-Za-z0-9]+)/gm)) {
    add(m[1]);
  }
  // vitest stack: ❯ path/to/file.ts:12:34
  for (const m of text.matchAll(/❯\s+(\S+\.[A-Za-z0-9]+)/g)) {
    add((m[1] ?? "").replace(/:\d+(?::\d+)?$/, ""));
  }
  // eslint / generic: path:line:col
  for (const m of text.matchAll(/(?:^|[\s"'])([^\s"'()]+?\.[A-Za-z0-9]+):\d+:\d+/gm)) {
    add(m[1]);
  }
  // eslint stylish: a lone path line (relative, with a known extension)
  for (const m of text.matchAll(/^\s*((?:src|tests|scripts|resources|electron)\/\S+\.[A-Za-z0-9]+)\s*$/gm)) {
    add(m[1]);
  }

  return found;
}

function isOwnedByTask(
  path: string,
  filesChanged: readonly string[],
  territory: readonly string[] | null | undefined,
): boolean {
  for (const raw of filesChanged) {
    const owned = normalizeDeclaredRepoPath(String(raw).replace(/^(?:shared|exclusive):/, ""));
    if (!owned) continue;
    if (path === owned || path.startsWith(`${owned}/`)) return true;
  }
  if (territory && territory.length > 0) return isInsideTerritory(path, territory);
  return false;
}

/**
 * Classify a measured gate run against the report's declared files. Pure.
 *
 *   - `ok` — every command exited 0
 *   - `gate_env_error` — a declared path / sandbox env failure (already measured)
 *   - `task_failed` — at least one error path sits in filesChanged or territory
 *   - `gate_inconclusive` — red with only foreign paths, or no path parseable
 *     (shared tree), or isolated red whose errors sit outside the applied set
 *     (depends on unintegrated neighbour work)
 */
export function classifyGateAttribution(input: {
  evidence: GateRunEvidence;
  filesChanged: readonly string[];
  territory?: readonly string[] | null;
}): GateAttribution {
  const perGate = formatPerGateScores(input.evidence.commands);
  if (input.evidence.commands.some((c) => c.failureKind === "gate_env_error")) {
    return { class: "gate_env_error", reason: "a declared path or sandbox environment failed", errorPaths: [], perGate };
  }
  if (input.evidence.ok || input.evidence.commands.every((c) => c.exitCode === 0)) {
    return { class: "ok", reason: null, errorPaths: [], perGate };
  }

  const failedOutputs = input.evidence.commands
    .filter((c) => c.exitCode !== 0)
    .map((c) => [c.stdout, c.stderr].filter(Boolean).join("\n"))
    .join("\n");
  const errorPaths = parseGateErrorPaths(failedOutputs);
  if (errorPaths.length === 0) {
    return {
      class: "gate_inconclusive",
      reason: "gate failed but no file path was parseable from the output",
      errorPaths: [],
      perGate,
    };
  }

  const ownedHits = errorPaths.filter((p) => isOwnedByTask(p, input.filesChanged, input.territory));
  if (ownedHits.length > 0) {
    return { class: "task_failed", reason: null, errorPaths, perGate };
  }

  const isolation = input.evidence.isolation;
  if (isolation?.mode === "isolated") {
    const applied = new Set(isolation.appliedFiles ?? []);
    const inApplied = errorPaths.filter((p) => applied.has(p) || [...applied].some((a) => p.startsWith(`${a}/`)));
    if (inApplied.length > 0) {
      return { class: "task_failed", reason: null, errorPaths, perGate };
    }
    return {
      class: "gate_inconclusive",
      reason: "isolated copy failed on paths outside this task's applied files — likely depends on unintegrated neighbour work",
      errorPaths,
      perGate,
    };
  }

  return {
    class: "gate_inconclusive",
    reason: "all parseable errors are outside this task's filesChanged/territory on a shared tree",
    errorPaths,
    perGate,
  };
}

/**
 * Self-standing gate notice when the measured result needs a named class on
 * the orchestrator line. `null` when report and gates agree on success, or
 * agree on a `task_failed` red (the report line already carries N/M).
 *
 * `gate_inconclusive` is NEVER worded as a contradiction — foreign reds on a
 * shared tree must not accuse the reporting task.
 */
export function describeGateContradiction(input: {
  taskId: string;
  title: string;
  /** `report.ok !== false` — what the report DECLARED. */
  reportOk: boolean;
  evidence: GateRunEvidence;
  filesChanged?: readonly string[];
  territory?: readonly string[] | null;
}): string | null {
  const attribution =
    input.evidence.attribution ??
    classifyGateAttribution({
      evidence: input.evidence,
      filesChanged: input.filesChanged ?? [],
      territory: input.territory,
    });
  const summary = gateRunSummaryFromEvidence(input.evidence);

  if (attribution.class === "gate_env_error") {
    return APP_NOTICE.gateEnvironmentError({ taskId: input.taskId });
  }
  if (attribution.class === "gate_inconclusive") {
    // Always name inconclusive when the measured run is red — never "contradiction".
    if (summary.ok) return null;
    const noPathParsed = attribution.errorPaths.length === 0;
    return APP_NOTICE.gateInconclusive({
      taskId: input.taskId,
      passed: summary.passed,
      total: summary.total,
      perGate: attribution.perGate,
      reason: attribution.reason,
      detail: noPathParsed
        ? "could not attribute the failure to any file (no path parsed)"
        : "errors look outside this task's files",
    });
  }
  if (summary.ok === input.reportOk) return null;
  if (attribution.class === "task_failed" || attribution.class === "ok") {
    return APP_NOTICE.gateContradiction({
      taskId: input.taskId,
      reportOk: input.reportOk,
      gatesOk: summary.ok,
      passed: summary.passed,
      total: summary.total,
      attributionClass: attribution.class === "ok" ? "ok" : "task_failed",
      perGate: attribution.perGate,
    });
  }
  return null;
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
