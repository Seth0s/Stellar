/**
 * Renaming a profile of the ACCOUNT (PATCH /v1/profiles/{id}): the pure part of
 * the main-process handler — what is checked before the request leaves, and what
 * the server's refusal means for the page. No I/O: the token and the network
 * live in `cloud-account-ipc.ts` and `cloud-api.ts`.
 */

import { MAX_PROFILE_NAME_LENGTH } from "./profiles-decision";

/** Why a rename of an account profile did not happen. */
export type AccountRenameFailure =
  | "invalid-name"
  | "duplicate-name"
  | "forbidden"
  | "not-found"
  | "offline"
  | "not-signed-in"
  | "failed";

export type AccountRenameResult =
  | { ok: true; profile: { id: string; name: string } }
  | { ok: false; reason: AccountRenameFailure };

/**
 * The same rule the server applies, checked first so a plain mistake never
 * costs a round trip: trimmed, not empty, at most `MAX_PROFILE_NAME_LENGTH`
 * characters, and no control characters.
 */
export function validateAccountProfileName(raw: unknown): { ok: true; name: string } | { ok: false; reason: "invalid-name" } {
  if (typeof raw !== "string") return { ok: false, reason: "invalid-name" };
  const name = raw.trim();
  if (name === "" || [...name].length > MAX_PROFILE_NAME_LENGTH) return { ok: false, reason: "invalid-name" };
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) return { ok: false, reason: "invalid-name" };
  return { ok: true, name };
}

/** What a failed request means. Status 0 is "no answer" (network, timeout). */
export function accountRenameFailure(error: { status: number; code: string }): AccountRenameFailure {
  switch (error.status) {
    case 0:
      return error.code === "network" || error.code === "timeout" ? "offline" : "failed";
    case 400:
      return "invalid-name";
    case 401:
      return "not-signed-in";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "duplicate-name";
    default:
      return error.status >= 502 && error.status <= 504 ? "offline" : "failed";
  }
}
