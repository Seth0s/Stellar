import { safeStorage } from "electron";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DESIGN-BACKLOG.md item 12, Fase B — the app's first credential of any
 * kind (confirmed by exploration: no `apiKey`/`safeStorage`/`keytar`
 * anywhere in the codebase before this). Every existing "secret"-shaped
 * thing (remote-pairing tokens, `main/remote-server.ts`) is a random
 * short-lived value, kept in-memory only, never written to disk — that
 * pattern doesn't fit an API key the user types once and expects to
 * persist across launches.
 *
 * `safeStorage` (OS keychain-backed encryption baked into Electron) is
 * the right primitive: encrypt in main, write the encrypted bytes
 * (base64'd, since they're binary) to a small JSON file under
 * `userData`, decrypt on read. Never touches `localStorage` (renderer-
 * side, unencrypted, not the right trust boundary for a secret) or the
 * sqlite `store.ts` (board/card data, a different concern).
 *
 * `safeStorage.isEncryptionAvailable()` can be false on a Linux box with
 * no secret-service backend running (no gnome-keyring/kwallet) — rather
 * than silently fail or throw, that case falls back to storing the key
 * in cleartext with `encrypted: false` recorded alongside it, and every
 * caller-facing surface should say so (Fase B's ChatCard settings UI
 * shows this). A working chatbox on a box without a keychain beats a
 * broken one that insists on encryption it structurally cannot provide.
 */

// DESIGN-BACKLOG.md item 28 — "gemini" talks to Google's own
// OpenAI-compatible endpoint (fixed baseURL, main/index.ts), so it reuses
// openai-client.ts wholesale; "generic" is the same reuse but with a
// USER-supplied baseURL instead of a fixed one — covers any other
// OpenAI-compatible endpoint (self-hosted, local models like Ollama/
// llama.cpp/vLLM, or a hosted provider with no dedicated UI here yet).
export type SecretProvider = "anthropic" | "openai" | "gemini" | "generic";

type SecretsFile = Record<SecretProvider, { value: string; encrypted: boolean; baseURL?: string } | undefined>;

function secretsPath(userDataDir: string): string {
  return join(userDataDir, "secrets.json");
}

function readAll(userDataDir: string): SecretsFile {
  const path = secretsPath(userDataDir);
  if (!existsSync(path)) return {} as SecretsFile;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Corrupt/malformed file — treat as empty rather than crash the app
    // over a settings file, same defensive posture as store.ts's row
    // parsers.
    return {} as SecretsFile;
  }
}

// Pre-release audit S9 — a crash mid-`writeFileSync` used to leave
// `secrets.json` truncated (`readAll` treats invalid JSON as empty, so a
// configured key would silently vanish), and `{ mode: 0o600 }` only ever
// applies to a FILE THE CALL ITSELF CREATES — once `secrets.json` already
// exists, every subsequent write leaves whatever mode it already had
// untouched. Write to a sibling `.tmp` path and `renameSync` over the real
// path instead (rename is atomic on the same filesystem, and `userDataDir`
// guarantees that): a crash mid-write leaves at worst a stray `.tmp` file,
// never a half-written `secrets.json`. `chmodSync` runs explicitly on the
// tmp file regardless, since it may itself be a leftover from a prior
// crash (already existing, so `writeFileSync`'s own `mode` wouldn't apply).
function writeAll(userDataDir: string, data: SecretsFile) {
  const path = secretsPath(userDataDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

export function createSecretsStore(userDataDir: string) {
  // Pre-release audit P4 — `has`/`get`/`getBaseURL` each re-read and
  // re-parsed `secrets.json` from disk on every single call (`chat:send`
  // alone triggers 2-3 per message). This process is the only writer of
  // this file (no other process/instance shares a `userDataDir`), so an
  // in-memory cache is always correct as long as every write here goes
  // through it too — `set`/`clear` below update `cache` directly with
  // the just-written state instead of invalidating and forcing a
  // re-read next time.
  let cache: SecretsFile | null = null;
  function loadCached(): SecretsFile {
    if (!cache) cache = readAll(userDataDir);
    return cache;
  }

  function has(provider: SecretProvider): boolean {
    return loadCached()[provider] !== undefined;
  }

  function get(provider: SecretProvider): string | null {
    const entry = loadCached()[provider];
    if (!entry) return null;
    if (!entry.encrypted) return entry.value;
    try {
      return safeStorage.decryptString(Buffer.from(entry.value, "base64"));
    } catch {
      // Encrypted under a different OS-keychain identity (rare — e.g. the
      // file was copied to another machine) — treat as "no key set"
      // rather than crash.
      return null;
    }
  }

  // Item 29 — `writeFileSync`/`encryptString` can both throw for real
  // (read-only filesystem, disk full, OS keychain rejecting the request)
  // and, before this, that just became an unhandled rejection on the
  // renderer side (`ipcMain.handle` auto-rejects the invoke promise on a
  // thrown error) — the save button stayed stuck in "salvando…" forever
  // with zero explanation. Typed result instead of throwing across the
  // IPC boundary, same shape every other fallible IPC call in this app
  // already uses.
  function set(provider: SecretProvider, value: string, baseURL?: string): { ok: true } | { ok: false; error: string } {
    try {
      const all = loadCached();
      const trimmed = value.trim();
      const trimmedBaseURL = baseURL?.trim() || undefined;
      if (safeStorage.isEncryptionAvailable()) {
        all[provider] = { value: safeStorage.encryptString(trimmed).toString("base64"), encrypted: true, baseURL: trimmedBaseURL };
      } else {
        all[provider] = { value: trimmed, encrypted: false, baseURL: trimmedBaseURL };
      }
      writeAll(userDataDir, all);
      cache = all;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Only "generic" ever has one set (the key form, ChatCard.tsx) — undefined
   * for every other provider, including "gemini" (its baseURL is a fixed
   * constant in main/index.ts, not user-configured). */
  function getBaseURL(provider: SecretProvider): string | null {
    return loadCached()[provider]?.baseURL ?? null;
  }

  function clear(provider: SecretProvider): { ok: true } | { ok: false; error: string } {
    try {
      const all = loadCached();
      delete all[provider];
      writeAll(userDataDir, all);
      cache = all;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  return { has, get, set, clear, isEncryptionAvailable, getBaseURL };
}
