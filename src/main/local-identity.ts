/**
 * Identidade local — a casca com I/O.
 *
 * Lê/escreve `local-identity.json` em `userData` e chama a decisão
 * pura de `local-identity-decision.ts`. Mesma divisão do resto do
 * repo (decisão testável × efeito colateral aqui), mesma postura de
 * escrita atômica de `locale-prefs.ts` / `secrets.ts`: sibling
 * `.tmp` + `renameSync` — um crash no meio da escrita nunca deixa um
 * arquivo truncado no lugar do bom (e se deixar, a decisão trata
 * truncado como malformed, com quarantena).
 *
 * O espelho no SQLite NÃO é escrito aqui — quem lê/estrutura o banco
 * é o chamador (`store.ts`), que passa a linha crua como `dbMirror` e
 * obedece `decision.writeMirror`. Esta casca não conhece better-sqlite3.
 *
 * Quarantena: quando a decisão manda, o arquivo suspeito é RENOMEADO
 * (nunca apagado, nunca sobrescrito) para
 * `local-identity.corrupt-<ts>.json`. Se o rename falhar (permissão,
 * disco), a escrita do arquivo novo é CANCELADA — a identidade ainda
 * assim é adotada em memória e o espelho do banco é atualizado, mas
 * bytes que não conseguimos preservar não são destruídos por cima.
 * `fileWritten: false` no resultado conta essa verdade.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decideLocalIdentity,
  LOCAL_IDENTITY_FILENAME,
  LOCAL_IDENTITY_QUARANTINE_PREFIX,
  LOCAL_IDENTITY_SCHEMA_VERSION,
  type LocalIdentity,
  type LocalIdentityDecision,
} from "./local-identity-decision";

export type ResolvedLocalIdentity = {
  identity: LocalIdentity;
  decision: LocalIdentityDecision;
  /** Caminho da quarantena criada, `null` se nenhuma. */
  quarantinePath: string | null;
  /** O arquivo foi de fato (re)escrito. `false` quando a decisão não
   * pediu escrita OU quando a quarantena falhou e a escrita foi
   * cancelada para não destruir bytes sem preservar. */
  fileWritten: boolean;
  /** Diagnóstico extra da casca (falha de quarantena/escrita), vazio
   * quando tudo correu como a decisão pediu. */
  note: string;
};

export function identityFilePath(userDataDir: string): string {
  return join(userDataDir, LOCAL_IDENTITY_FILENAME);
}

/**
 * Resolve a identidade desta instalação: lê o arquivo (ausente =
 * `null`), chama a decisão pura, executa quarantena/escrita atômica e
 * devolve a identidade adotada junto com o que foi feito — o
 * chamador (store.ts) usa `decision.writeMirror` para o espelho SQL.
 *
 * `generateId`/`now` são injetáveis para teste; em produção são
 * `randomUUID` e `Date.now` (regra b: o id é `randomUUID()` e ponto —
 * nenhuma outra fonte).
 */
export function resolveLocalIdentity(
  userDataDir: string,
  opts: { dbMirror?: unknown; now?: number; generateId?: () => string } = {},
): ResolvedLocalIdentity {
  const path = identityFilePath(userDataDir);
  const now = opts.now ?? Date.now();
  const generateId = opts.generateId ?? randomUUID;

  let raw: string | null = null;
  if (existsSync(path)) {
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      // Existe mas não deu para ler (permissão etc). Não é "ausente":
      // string vazia cai em malformed na decisão, que pede quarantena.
      raw = "";
    }
  }

  const decision = decideLocalIdentity({
    raw,
    dbMirror: opts.dbMirror ?? null,
    generateId,
    now,
  });

  let quarantinePath: string | null = null;
  let note = "";
  let fileWritten = false;

  const fileThere = existsSync(path);
  let mayWrite = decision.writeFile;

  if (decision.quarantine && fileThere) {
    quarantinePath = join(userDataDir, `${LOCAL_IDENTITY_QUARANTINE_PREFIX}${now}.json`);
    try {
      renameSync(path, quarantinePath);
    } catch (e) {
      // Não conseguimos preservar → não podemos sobrescrever.
      note = `quarantena falhou (${e instanceof Error ? e.message : String(e)}); arquivo NÃO foi reescrito — bytes preservados no lugar`;
      quarantinePath = null;
      mayWrite = false;
    }
  }

  if (mayWrite) {
    const payload = JSON.stringify({
      schema_version: LOCAL_IDENTITY_SCHEMA_VERSION,
      user_id: decision.identity.user_id,
      install_id: decision.identity.install_id,
      created_at: decision.identity.created_at,
    });
    const tmpPath = `${path}.tmp`;
    try {
      writeFileSync(tmpPath, payload);
      renameSync(tmpPath, path);
      fileWritten = true;
    } catch (e) {
      note = `escrita atômica falhou (${e instanceof Error ? e.message : String(e)}); identidade adotada em memória, arquivo pendente`;
    }
  }

  return { identity: decision.identity, decision, quarantinePath, fileWritten, note };
}
