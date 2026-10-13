/**
 * The e-mail login's confirmation-code field, decided without mounting the
 * screen: what the main process reports (attempts left, blocked) and which
 * message a failed attempt shows.
 */

import type { MessageKey } from "../../shared/i18n";
import type { CloudCodeClaimResult, CloudStatusInfo } from "../../preload/index";
import { loginErrorKey } from "./login-flow-decision";

/** Wrong codes the server accepts before it cancels the request. */
export const CODE_ATTEMPTS = 3;
/** `481-925`: the formatted length the field waits for. */
const CODE_FULL_LENGTH = 7;

export type CodeStatus = { attemptsLeft: number | null; blocked: boolean };

/** What the pending status says about the code field; nothing outside a pending e-mail login. */
export function readCodeStatus(status: CloudStatusInfo | null): CodeStatus {
  if (status?.state !== "pending") return { attemptsLeft: null, blocked: false };
  return {
    attemptsLeft: typeof status.codeAttemptsLeft === "number" ? status.codeAttemptsLeft : null,
    blocked: status.codeBlocked === true,
  };
}

/** What the field shows while typing: digits only, a dash after the third. */
export function formatUserCodeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 6);
  return digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits;
}

export function isCodeComplete(formatted: string): boolean {
  return formatted.length === CODE_FULL_LENGTH;
}

/** "Código incorreto. Restam N tentativas." — singular for the last one. */
export function wrongCodeKey(attemptsLeft: number): MessageKey {
  return attemptsLeft === 1 ? "LoginScreen.code.wrongLast" : "LoginScreen.code.wrong";
}

export type CodeFeedback =
  | { kind: "none" }
  /** A wrong (or not accepted) code; `attemptsLeft` is what the message states. */
  | { kind: "wrong"; attemptsLeft: number }
  /** The code could not be checked at all: the message is the connection error. */
  | { kind: "unreachable"; key: MessageKey };

/**
 * What the field shows after `claimCode` answered. `knownLeft` is the count the
 * status already carried (null before any wrong code). Approved, blocked and
 * ended need no message here: the status push moves the screen.
 */
export function feedbackForClaim(result: CloudCodeClaimResult, knownLeft: number | null): CodeFeedback {
  switch (result.kind) {
    case "wrong":
      return { kind: "wrong", attemptsLeft: result.attemptsLeft };
    case "not-spent":
      return { kind: "wrong", attemptsLeft: knownLeft ?? CODE_ATTEMPTS };
    case "unreachable":
      return { kind: "unreachable", key: loginErrorKey(result.code) ?? "cloud.error.generic" };
    default:
      return { kind: "none" };
  }
}
