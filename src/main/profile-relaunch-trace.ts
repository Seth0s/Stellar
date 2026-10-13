/**
 * RELAUNCH TRACE — one line per step of a profile switch, written next to the
 * profile registry, so a switch that does not come back can be read afterwards.
 *
 * Why it exists: switching the machine profile quits the app and starts a new
 * process (`app.relaunch`). That new process has no terminal and no journal
 * attribution, so when it dies before showing a window nothing says where. Each
 * step appends a line here: the old process (`switching`), the new one at each
 * stage it reaches (`booted` → `window`) or the reason it left (`lock-lost`).
 * A switch that stops after `switching` never started; one that stops after
 * `booted` hung before the window.
 *
 * Only a process started by a switch (it carries `--profile=`) writes; a plain
 * launch leaves no trace. Never throws: the trace must not be able to break a boot.
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProfileArg } from "./profiles-decision";

export const RELAUNCH_TRACE_FILE = "relaunch-trace.log";
/** Beyond this the oldest half is dropped, so the file never grows without bound. */
export const RELAUNCH_TRACE_MAX_BYTES = 64 * 1024;

export type RelaunchStep = "switching" | "booted" | "window" | "lock-lost";

export type RelaunchTraceInput = {
  step: RelaunchStep;
  pid: number;
  ppid: number;
  /** The profile being opened (or switched to). */
  profileId: string | null;
  nowMs: number;
};

/** One trace line (JSON, no secrets: ids and a clock only). */
export function formatRelaunchTraceLine(input: RelaunchTraceInput): string {
  return JSON.stringify({
    at: new Date(input.nowMs).toISOString(),
    step: input.step,
    pid: input.pid,
    ppid: input.ppid,
    profile: input.profileId,
  });
}

/** Whether this process was started by a profile switch. */
export function startedBySwitch(argv: readonly string[]): boolean {
  return parseProfileArg(argv) !== null;
}

/** Keeps the newest lines when the text outgrew `maxBytes`. Pure. */
export function trimTrace(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const lines = text.split("\n").filter((l) => l !== "");
  return lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n";
}

export function appendRelaunchTrace(baseUserDataDir: string, input: RelaunchTraceInput): void {
  try {
    const path = join(baseUserDataDir, RELAUNCH_TRACE_FILE);
    appendFileSync(path, `${formatRelaunchTraceLine(input)}\n`);
    if (statSync(path).size > RELAUNCH_TRACE_MAX_BYTES) {
      writeFileSync(path, trimTrace(readFileSync(path, "utf8"), RELAUNCH_TRACE_MAX_BYTES));
    }
  } catch {
    /* a trace that cannot be written is not worth a failed boot */
  }
}
