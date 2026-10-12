/**
 * The last account the app saw, kept on this machine so a start WITHOUT a
 * connection can still show who the account is (name, e-mail/login) and when
 * that was last refreshed. Not a secret — the refresh token lives in
 * `cloud-tokens.ts` — so it is a plain JSON file in the profile's userData,
 * written atomically.
 *
 * The cache is dropped on logout and when the saved session is refused: it
 * describes a session that exists, never a signed-out one.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloudAccount } from "./cloud-auth-decision";

export const CLOUD_ACCOUNT_CACHE_FILENAME = "cloud-account.json";

export type CachedAccount = {
  account: CloudAccount;
  /** When the server last confirmed this account (epoch ms). */
  savedAtMs: number;
};

function isCachedAccount(value: unknown): value is CachedAccount {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  const account = rec.account as Record<string, unknown> | undefined;
  return (
    typeof rec.savedAtMs === "number" &&
    typeof account === "object" &&
    account !== null &&
    typeof account.displayName === "string" &&
    Array.isArray(account.identities)
  );
}

export function createCloudAccountCache(userDataDir: string) {
  const path = join(userDataDir, CLOUD_ACCOUNT_CACHE_FILENAME);

  return {
    read(): CachedAccount | null {
      if (!existsSync(path)) return null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        return isCachedAccount(parsed) ? parsed : null;
      } catch {
        // Unreadable = no cache: the screen just says there is nothing saved.
        return null;
      }
    },
    write(value: CachedAccount): void {
      try {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
        renameSync(tmp, path);
      } catch {
        // A cache that does not write never breaks the sign-in.
      }
    },
    clear(): void {
      try {
        rmSync(path, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

export type CloudAccountCache = ReturnType<typeof createCloudAccountCache>;
