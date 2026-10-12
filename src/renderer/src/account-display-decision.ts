/**
 * What the UI says about the account, decided in one place so the profile
 * selector, the sidebar footer and the pages show the same thing: WHO is
 * signed in, and WHY an account call failed.
 */

import type { CloudAccountInfo, CloudStatusInfo } from "../../preload/index";

export type AccountIdentityView = {
  /** The account's display name. */
  name: string;
  /** The e-mail address or the GitHub login the user signed in with; "" when unknown. */
  identity: string;
};

/**
 * The identity line for an account: an e-mail address wins over a GitHub
 * login (it is what the user typed), and a GitHub login reads as `login · GitHub`.
 */
export function accountIdentity(account: CloudAccountInfo): AccountIdentityView {
  const email = account.identities.find((i) => i.kind === "email" && i.subject !== "");
  if (email) return { name: account.displayName, identity: email.subject };
  const github = account.identities.find((i) => i.kind === "github" && (i.login ?? "") !== "");
  if (github) return { name: account.displayName, identity: `${github.login} · GitHub` };
  const any = account.identities.find((i) => (i.login ?? i.subject) !== "");
  return { name: account.displayName, identity: any ? (any.login ?? any.subject) : "" };
}

/** The signed-in account's identity, or `null` without one. */
export function statusIdentity(status: CloudStatusInfo | null | undefined): AccountIdentityView | null {
  return status?.state === "logged-in" ? accountIdentity(status.account) : null;
}

const CONNECTIVITY_PATTERN =
  /fetch failed|failed to fetch|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|socket hang up|timed out|timeout|aborted/i;

/**
 * Whether a raw error string from an account call says the API could not be
 * reached (no connection, DNS, timeout) rather than that it refused. Account
 * IPC replies carry the error as text, so this is the one place that reads it.
 */
export function isConnectivityFailure(raw: string | null | undefined): boolean {
  return !!raw && CONNECTIVITY_PATTERN.test(raw);
}

/** What an offline start still knows of the account: who it is and when that was last confirmed. */
export type OfflineAccount = { account: CloudAccountInfo; savedAtMs: number };

/** The cached account of an offline saved session, or `null` when the machine has none. */
export function readOfflineAccount(status: CloudStatusInfo | null | undefined): OfflineAccount | null {
  if (status?.state !== "logged-out") return null;
  const raw = (status as { cachedAccount?: { account?: CloudAccountInfo; savedAtMs?: unknown } }).cachedAccount;
  if (!raw || typeof raw.savedAtMs !== "number" || !raw.account || !Array.isArray(raw.account.identities)) return null;
  return { account: raw.account, savedAtMs: raw.savedAtMs };
}

/** A saved session exists but the API is unreachable; the app retries by itself. */
export function isSessionOffline(status: CloudStatusInfo | null | undefined): boolean {
  if (status?.state !== "logged-out") return false;
  return (status as { sessionOffline?: unknown }).sessionOffline === true;
}

/** "12/10 14:32" in the user's locale: when a stale piece of data was last refreshed. */
export function formatStaleStamp(ms: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}
