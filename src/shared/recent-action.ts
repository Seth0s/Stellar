/** ANSI SGR stripper — built from a string so `no-control-regex` stays quiet
 * (same pattern as `session-scrollback.ts`). */
const ANSI_SGR = new RegExp(`\\u001b\\[[0-9;]*m`, "g");

/** Summarize the last measured agent action from a PTY output tail.
 * Absence stays null — never invents work the card did not show. */
export function summarizeRecentAction(tail: string | null | undefined): string | null {
  if (!tail) return null;
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.replace(ANSI_SGR, "").trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  let last = lines[lines.length - 1]!;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const line = lines[i]!;
    if (/^[●•]\s/.test(line) || /^(Read|Edit|Write|Bash|Grep|Glob)\b/.test(line)) {
      last = line.replace(/^[●•]\s*/, "");
      break;
    }
  }
  if (last.length > 72) last = `${last.slice(0, 69)}…`;
  return last;
}
