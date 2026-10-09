/**
 * Map checker diagnostics into the Problems panel shape.
 */

import type { RawCheckerDiagnostic } from "../../shared/code-checker-output-decision";

export type RawDiagnostic = RawCheckerDiagnostic;

export type CodeProblem = {
  path: string;
  line: number;
  message: string;
  severity: "error" | "warning";
};

/** Keep only error/warning rows with a usable line; drop empty messages. */
export function decideCodeProblems(raw: readonly RawDiagnostic[]): CodeProblem[] {
  const out: CodeProblem[] = [];
  for (const d of raw) {
    const path = d.file.replace(/\\/g, "/");
    const line = Number.isFinite(d.line) && d.line >= 1 ? Math.floor(d.line) : 1;
    const message = d.message.trim();
    if (!path || !message) continue;
    const severity: "error" | "warning" =
      d.category === "warning" || d.category === "suggestion" ? "warning" : "error";
    out.push({ path, line, message, severity });
  }
  return out;
}

export { decideParseCheckerOutput } from "../../shared/code-checker-output-decision";
