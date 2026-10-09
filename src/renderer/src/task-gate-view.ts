/**
 * The gate CHIP on the Fila — the `gateRun` slice and the live progress turn
 * into what the screen draws. Pure: no React, no I/O.
 *
 * The app measures the gates and stamps `result_json.gateRun`; the board push
 * (`task:changed`) carries the compact slice (`TaskBoardItem.gateRun`) and the
 * live progress (`TaskBoardItem.gateProgress`). Here we only decide WHICH chip
 * appears and what the tooltip says — the verdict is never reinterpreted: it
 * is the exit code, as everywhere else in the runner.
 */

import { t } from "../../shared/i18n";

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
  failedOutput: string | null;
  commands?: { cmd: string; ok: boolean }[] | null;
};

export type TaskGateProgress = { index: number; total: number; command: string };

export type GateChipTone = "running" | "good" | "danger";

export type GateChip = {
  tone: GateChipTone;
  label: string;
  /** Tooltip body: command, mode and the trailing output when red. */
  title: string;
};

/** Where the gate was measured, in short prose. `null` when it is unknown (old
 * row, no `isolation`) — absence is data, not "shared". */
export function describeGateMode(isolation: TaskGateIsolationView | null | undefined): string | null {
  if (!isolation) return null;
  const base = isolation.mode === "isolated" ? t("task.gate.mode.isolated") : t("task.gate.mode.shared");
  if (isolation.mode === "shared" && isolation.reason) return `${base} — ${isolation.reason}`;
  if (isolation.mode === "isolated" && isolation.undeclaredInTerritory.length > 0) {
    return `${base} — ${t("task.gate.undeclared", { n: isolation.undeclaredInTerritory.length })}`;
  }
  return base;
}

/** The task chip: progress, verdict or nothing. Progress wins — a running gate
 * is the current state even when an earlier verdict exists. */
export function describeGateChip(
  gate: TaskGateView | null | undefined,
  progress: TaskGateProgress | null | undefined,
): GateChip | null {
  if (progress) {
    const vars = { i: progress.index, n: progress.total, cmd: progress.command };
    return { tone: "running", label: t("task.gate.running", vars), title: t("task.gate.runningTitle", vars) };
  }
  if (!gate) return null;
  const label = t("task.gate.result", { p: gate.passed, n: gate.total });
  const titleLines = [label];
  if (gate.failedCommand) titleLines.push(t("task.gate.command", { cmd: gate.failedCommand }));
  const mode = describeGateMode(gate.isolation);
  if (mode) titleLines.push(t("task.gate.mode", { mode }));
  if (gate.failedOutput) titleLines.push(gate.failedOutput);
  return { tone: gate.ok ? "good" : "danger", label, title: titleLines.join("\n") };
}
