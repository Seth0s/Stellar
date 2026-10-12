/**
 * Login flow decisions — pure, so the screen's branching is testable without
 * mounting it. The main process reports a failed login as a machine code in
 * `CloudStatus.lastError` (see `LOGIN_ERROR` in cloud-auth-decision.ts); this
 * module turns that into a message key and decides where the screen goes after
 * `window.cloud.login` answers.
 */

import type { MessageKey } from "../../shared/i18n";
import type { CloudStatusInfo } from "../../preload/index";

type LoginProvider = "github" | "email";

/** Machine code → message. Keep in sync with `LOGIN_ERROR` in cloud-auth-decision.ts. */
const LOGIN_ERROR_KEYS: Record<string, MessageKey> = {
  signup_closed: "cloud.error.signupClosed",
  email_unavailable: "cloud.error.emailUnavailable",
  rate_limited: "cloud.error.rateLimited",
  invalid_email: "cloud.error.invalidEmail",
  network: "cloud.error.network",
  timeout: "cloud.error.timeout",
  email_failed: "cloud.error.emailFailed",
  login_timeout: "cloud.error.loginTimeout",
  api_unavailable: "cloud.error.apiUnavailable",
};

/** The message for a login machine code, or `null` when it is not one. */
export function loginErrorKey(lastError: string | null | undefined): MessageKey | null {
  if (!lastError) return null;
  return LOGIN_ERROR_KEYS[lastError] ?? null;
}

/**
 * The error to show for a status. While a login attempt is in flight any
 * `lastError` counts (an unknown one reads as a generic failure); outside an
 * attempt only a known login code does, so a stale session error from the
 * boot-time restore never shows up on a fresh login screen.
 */
export function loginErrorForStatus(status: CloudStatusInfo, attempting: boolean): MessageKey | null {
  if (status.state !== "logged-out" || !status.lastError) return null;
  return loginErrorKey(status.lastError) ?? (attempting ? "cloud.error.generic" : null);
}

export type LoginAttemptOutcome =
  | { kind: "waiting-email" }
  | { kind: "waiting-browser" }
  | { kind: "signed-in" }
  | { kind: "failed"; errorKey: MessageKey };

/**
 * What the screen does with the status `window.cloud.login` resolved to.
 * An e-mail login is "waiting" only once the server accepted the request
 * (`pending` is not emitted before that); a logged-out answer is a failure
 * even without a `lastError`.
 */
export function decideLoginOutcome(provider: LoginProvider, status: CloudStatusInfo): LoginAttemptOutcome {
  if (status.state === "logged-in") return { kind: "signed-in" };
  if (status.state === "pending") return { kind: provider === "email" ? "waiting-email" : "waiting-browser" };
  return { kind: "failed", errorKey: loginErrorForStatus(status, true) ?? "cloud.error.generic" };
}

/** What a GitHub login needs from the pending status beyond the base type. */
export type PendingLoginExtras = { loginUrl: string | null; openFailed: boolean };

export function readPendingExtras(status: CloudStatusInfo | null): PendingLoginExtras {
  if (status?.state !== "pending") return { loginUrl: null, openFailed: false };
  const extra = status as { loginUrl?: unknown; openFailed?: unknown };
  return {
    loginUrl: typeof extra.loginUrl === "string" && extra.loginUrl !== "" ? extra.loginUrl : null,
    openFailed: extra.openFailed === true,
  };
}
