import { APP_NOTICE } from "./agent-facing-notices";

/**
 * The provider trust prompt — decision only, no I/O.
 *
 * A newly spawned agent CLI can stop on a "do you trust this project?" dialog
 * before it reads its brief, and wait forever for a human who is not watching.
 * The rule:
 *   - the prompt pattern and the input that confirms it are DECLARED by the
 *     provider (`providers.ts`); this module receives them as facts and knows
 *     no provider by name, so there is no `if (provider === …)` in the spawn path;
 *   - INSIDE the board's declared root the app confirms the prompt: that is the
 *     folder the human chose for this board;
 *   - OUTSIDE that root, or when the provider declares no confirm input, the
 *     app does NOT confirm and warns the orchestrator instead — confirming
 *     trust in a folder the board did not declare would sign trust on its own
 *     somewhere it does not know.
 *
 * Who types the input and who sends the warning is the caller's job.
 */

export type TrustPromptAction = "confirm" | "warn" | "ignore";
export type TrustPromptDecision = { action: TrustPromptAction };

/**
 * Does the screen (or an output chunk) show the provider's trust prompt? Pure.
 * `pattern` is the provider's declared pattern; `null`/absent means the
 * provider declares no such prompt, so the answer is false rather than a guess.
 *
 * A global `RegExp` carries state (`lastIndex`) between calls, so the pattern
 * is cloned without the `g` flag and the answer never depends on a prior call.
 */
export function screenShowsTrustPrompt(screen: string, pattern: RegExp | null | undefined): boolean {
  if (!pattern || typeof screen !== "string" || screen.length === 0) return false;
  const re = pattern.global ? new RegExp(pattern.source, pattern.flags.replace(/g/g, "")) : pattern;
  return re.test(screen);
}

/**
 * Confirm, warn, or ignore. `ignore` = the prompt is not on screen.
 *
 * `providerConfirmInput` is the provider's declared confirm input: `null` means
 * it declares none (the app must never auto-confirm — a bare Enter can land on
 * the cancel button for some CLIs), which warns even inside the root.
 */
export function decideTrustPromptAction(input: {
  /** `screenShowsTrustPrompt` already answered for this screen. */
  patternMatched: boolean;
  /** The card's cwd falls INSIDE the board's declared root (and a root exists). */
  cwdWithinDeclaredRoot: boolean;
  /** The provider's declared confirm input, or null when it declares none. */
  providerConfirmInput: string | null;
}): TrustPromptDecision {
  if (!input.patternMatched) return { action: "ignore" };
  if (input.providerConfirmInput === null) return { action: "warn" };
  return input.cwdWithinDeclaredRoot ? { action: "confirm" } : { action: "warn" };
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd. The warning sent to the
 * orchestrator when the prompt appears outside the declared root: the app did
 * not confirm it. */
export function describeTrustPromptOutsideRootWarning(input: {
  cardId?: string;
  providerId: string;
  cwd: string;
  root: string | null;
}): string {
  return APP_NOTICE.trustPrompt({
    cardId: input.cardId ?? "unknown",
    provider: input.providerId,
    cwd: input.cwd,
    root: input.root,
  });
}
