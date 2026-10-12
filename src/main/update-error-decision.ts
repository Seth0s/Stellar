/**
 * WHAT WENT WRONG WITH THE UPDATE, in terms the dialog can explain.
 *
 * `electron-updater` reports every failure as an `Error` with a free-form
 * message (and sometimes a node `code`). The dialog needs one of four causes —
 * network, signature, disk or "something else" — because each one tells the
 * user a different thing to do. Pure, so the mapping is testable without a
 * network or a full disk.
 *
 * Order matters: a full disk can surface as a write error inside a download
 * that also looks like a network failure, so the more specific causes are
 * checked first.
 */
export type UpdateErrorKind = "network" | "signature" | "disk" | "unknown";

const DISK_RE = /ENOSPC|no space left|disk quota/i;
const SIGNATURE_RE = /checksum|sha512|sha256|signature|not signed|ERR_UPDATER_.*(SIGN|CHECKSUM)/i;
const NETWORK_RE =
  /net::ERR_|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|getaddrinfo|socket hang up|timed out|HttpError|ERR_INTERNET|ERR_NETWORK/i;

export function classifyUpdateError(input: { code?: string | null; message: string }): UpdateErrorKind {
  const haystack = `${input.code ?? ""} ${input.message}`;
  if (DISK_RE.test(haystack)) return "disk";
  if (SIGNATURE_RE.test(haystack)) return "signature";
  if (NETWORK_RE.test(haystack)) return "network";
  return "unknown";
}

/** The user cancelled the download — not a failure, the dialog goes back to "available". */
export function isUpdateCancellation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "CancellationError" || /^cancelled$/i.test(err.message.trim());
}

/** The first line of a message, capped, so a stack never lands in the dialog. */
export function firstLine(message: string, max = 240): string {
  const line = message.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
