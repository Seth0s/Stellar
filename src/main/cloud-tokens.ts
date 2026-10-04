/**
 * Refresh token da conta Stellar — persistência no `safeStorage` DO PERFIL
 * (BACKEND_V1.md §4: "o refresh token fica no `safeStorage` do perfil").
 *
 * Mesmo padrão de `secrets.ts`: cifra com `safeStorage` (chavechain do SO),
 * grava os bytes cifrados (base64) num JSON pequeno sob o `userData` do perfil,
 * decifra na leitura, e faz escrita ATÔMICA (`.tmp` + `renameSync`, `chmod
 * 0600`). Sem keychain disponível (Linux sem secret-service), cai para
 * cleartext com `encrypted:false` — um app que funciona vale mais que um que
 * insiste numa criptografia que a máquina não oferece; a UI pode dizer isso.
 *
 * NÃO vai para `localStorage` (renderer, sem cifra) nem para o `store.ts`
 * (dados de board). O access token NUNCA é gravado — vive só em memória.
 */

import { safeStorage } from "electron";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLOUD_AUTH_FILENAME = "cloud-auth.json";

type CloudAuthFile = { refreshToken?: { value: string; encrypted: boolean }; linked?: boolean };

export function cloudAuthPath(userDataDir: string): string {
  return join(userDataDir, CLOUD_AUTH_FILENAME);
}

function readAll(path: string): CloudAuthFile {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CloudAuthFile;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    // Corrompido = "sem refresh". Um arquivo de sessão ilegível nunca derruba o
    // app; a pessoa entra de novo.
    return {};
  }
}

function writeAll(path: string, data: CloudAuthFile): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function createCloudTokenStore(userDataDir: string) {
  const path = cloudAuthPath(userDataDir);
  let cache: CloudAuthFile | null = null;
  const load = (): CloudAuthFile => (cache ??= readAll(path));

  function getRefreshToken(): string | null {
    const entry = load().refreshToken;
    if (!entry || entry.value === "") return null;
    if (!entry.encrypted) return entry.value;
    try {
      return safeStorage.decryptString(Buffer.from(entry.value, "base64"));
    } catch {
      // Cifrado sob outra identidade de keychain (arquivo copiado de outra
      // máquina): trata como "sem sessão" em vez de quebrar.
      return null;
    }
  }

  function setRefreshToken(token: string): { ok: true } | { ok: false; error: string } {
    try {
      const trimmed = token.trim();
      const next: CloudAuthFile = {
        ...load(),
        refreshToken: safeStorage.isEncryptionAvailable()
          ? { value: safeStorage.encryptString(trimmed).toString("base64"), encrypted: true }
          : { value: trimmed, encrypted: false },
      };
      writeAll(path, next);
      cache = next;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * "Já anexou o user_id local"? §3: o `user_id` é anexado no PRIMEIRO login.
   * Marcado após o primeiro login e PRESERVADO no logout — o user_id continua
   * ligado à conta no servidor, então um login seguinte (de outro provedor) não
   * deve reenviá-lo (o backend recusa com 409 `user_id_taken`, pois o id já
   * pertence àquela conta) nem desanexá-lo.
   */
  function isLinked(): boolean {
    return load().linked === true;
  }

  function setLinked(linked: boolean): void {
    const next: CloudAuthFile = { ...load(), linked };
    try {
      writeAll(path, next);
      cache = next;
    } catch {
      // Preferência que não grava não derruba o login: a memória já foi marcada.
      cache = next;
    }
  }

  /** Logout: esquece o refresh, MAS mantém `linked` (o user_id segue anexado). */
  function clear(): void {
    try {
      writeAll(path, { linked: load().linked });
      cache = { linked: load().linked };
    } catch {
      // Limpar a sessão que não grava não pode derrubar o logout: a memória já
      // foi limpa pelo chamador; o arquivo fica para o próximo boot.
    }
  }

  function isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  return { getRefreshToken, setRefreshToken, isLinked, setLinked, clear, isEncryptionAvailable };
}

export type CloudTokenStore = ReturnType<typeof createCloudTokenStore>;
