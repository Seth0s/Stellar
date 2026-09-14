/**
 * Single source of truth for the agent-facing authorship prefix
 * (`[de: <label>] …`) that lands in a PTY via `send_to_card` or the
 * report / exit-without-report pointers.
 *
 * Why this module exists (2026-09-14, live double-prefix on card 330):
 * `send` stamped `[de: ${senderLabel}] ${text}` while callers (and the
 * report pointer) could already ship a line that started with the same
 * convention. Two construction sites, neither aware of the other → one
 * delivery, two prefixes. The defect is a second source of truth in
 * *presentation*, not a missing string guard.
 *
 * Design cut (seq 232 — reapplied after git reset --hard wiped the tree):
 * - Form is assembled HERE only. `send` and `notifySpawnerOfReport` /
 *   `notifySpawnerOfUnreportedExit` / `notifySpawnerOfUnreportedIdle`
 *   both call this; they do not hand-roll
 *   the prefix. `enqueueCardDelivery` stays a dumb FIFO of final text —
 *   status-write / task-drag already author full lines with synthetic
 *   labels (`stellar`, `você`) and are not "card X says Y".
 * - Authorship-as-data through the delivery queue would be cleaner
 *   internally, but the PTY consumer still reads text. The prefix is the
 *   legitimate wire format to the agent; this helper is where `from` (data)
 *   becomes that wire form, once.
 * - Skipping when the body already carries `[de: …]` is a defensive
 *   property of the single formatter (freeform `send_to_card` text can
 *   copy the convention). Alone inside `send` it would be a patch; here
 *   it is what keeps one form idempotent.
 * - No content dedupe in the FIFO: two byte-identical deliveries can be
 *   intentional (card 469, seq 222+223). Identity is the delivery `id`.
 */

/** True when `text` already opens with the authorship convention. */
export function hasAgentFacingAuthorPrefix(text: string): boolean {
  return /^\[de:\s*[^\]]+\]/.test(text);
}

/**
 * Render authorship for a PTY-bound line.
 * - `from` empty → body unchanged (bash targets / anonymous send).
 * - body already authored → body unchanged (no second stamp).
 * - else → `[de: ${from}] ${body}`.
 */
export function formatAgentFacingAuthorship(from: string | null | undefined, body: string): string {
  const text = body ?? "";
  if (!from) return text;
  if (hasAgentFacingAuthorPrefix(text)) return text;
  return `[de: ${from}] ${text}`;
}

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n). */
export const REPORT_AVAILABLE_POINTER_BODY =
  "relatório disponível — chame read_report para ver o resultado.";

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n). */
export function unreportedExitPointerBody(exitCode: number): string {
  return `saiu (código ${exitCode}) sem chamar report.`;
}

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
 * SINAL 3 — card still alive, idle long enough, never called report. */
export function unreportedIdlePointerBody(): string {
  return "idle sem chamar report.";
}
