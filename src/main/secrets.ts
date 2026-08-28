import { safeStorage } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function writeAll(userDataDir: string, data: SecretsFile) {
  writeFileSync(secretsPath(userDataDir), JSON.stringify(data), { mode: 0o600 });
}

export function createSecretsStore(userDataDir: string) {
  function has(provider: SecretProvider): boolean {
    return readAll(userDataDir)[provider] !== undefined;
  }

  function get(provider: SecretProvider): string | null {
    const entry = readAll(userDataDir)[provider];
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
      const all = readAll(userDataDir);
      const trimmed = value.trim();
      const trimmedBaseURL = baseURL?.trim() || undefined;
      if (safeStorage.isEncryptionAvailable()) {
        all[provider] = { value: safeStorage.encryptString(trimmed).toString("base64"), encrypted: true, baseURL: trimmedBaseURL };
      } else {
        all[provider] = { value: trimmed, encrypted: false, baseURL: trimmedBaseURL };
      }
      writeAll(userDataDir, all);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Only "generic" ever has one set (the key form, ChatCard.tsx) — undefined
   * for every other provider, including "gemini" (its baseURL is a fixed
   * constant in main/index.ts, not user-configured). */
  function getBaseURL(provider: SecretProvider): string | null {
    return readAll(userDataDir)[provider]?.baseURL ?? null;
  }

  function clear(provider: SecretProvider): { ok: true } | { ok: false; error: string } {
    try {
      const all = readAll(userDataDir);
      delete all[provider];
      writeAll(userDataDir, all);
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
