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
  inspectIdentityFile,
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
  /** A canônica da MÁQUINA foi criada nesta chamada (primeiro run). */
  canonicalWritten: boolean;
  /** Caminho da canônica, `null` quando nenhum diretório de máquina foi
   * configurado (testes que resolvem um diretório solto). */
  canonicalPath: string | null;
  /** Diagnóstico extra da casca (falha de quarantena/escrita), vazio
   * quando tudo correu como a decisão pediu. */
  note: string;
};

/**
 * Identidade canônica da MÁQUINA (raiz do userData). `user_id`/`install_id`
 * são da PESSOA e da MÁQUINA, não do perfil: este arquivo é a fonte que
 * mantém os ids iguais em todos os perfis (BACKEND_V1.md §3, item 5). Cada
 * perfil tem a sua cópia em `profiles/<id>/local-identity.json`, adotada
 * daqui quando falta. Sem diretório configurado, a casca se comporta como
 * antes (a identidade nasce/serve o próprio diretório passado).
 */
let machineIdentityDir: string | null = null;

export function setMachineIdentityDir(dir: string | null): void {
  machineIdentityDir = dir;
}

export function getMachineIdentityDir(): string | null {
  return machineIdentityDir;
}

export function canonicalIdentityFilePath(dir: string): string {
  return join(dir, LOCAL_IDENTITY_FILENAME);
}

export function identityFilePath(userDataDir: string): string {
  return join(userDataDir, LOCAL_IDENTITY_FILENAME);
}

/**
 * Lê a identidade de um diretório SEM efeito colateral — não cria arquivo, não
 * quarentena, não escreve espelho. É o que o login (A2) usa para mandar
 * `user_id`/`install_id` (BACKEND_V1.md §3): ler para entrar não pode disparar
 * escrita de identidade. `null` = arquivo ausente/ilegível/inutilizável.
 */
export function readLocalIdentityFile(userDataDir: string): LocalIdentity | null {
  const path = identityFilePath(userDataDir);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const finding = inspectIdentityFile(raw);
  if (finding.kind === "valid") return finding.identity;
  if (finding.kind === "future" && finding.identity) return finding.identity;
  return null;
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

  // A canônica da MÁQUINA (raiz), quando configurada. `null` = nenhum
  // diretório de máquina (testes) → comportamento antigo, sem adoção.
  const canonicalPath = machineIdentityDir ? canonicalIdentityFilePath(machineIdentityDir) : null;
  let canonicalRaw: string | null = null;
  if (canonicalPath && existsSync(canonicalPath)) {
    try {
      canonicalRaw = readFileSync(canonicalPath, "utf-8");
    } catch {
      canonicalRaw = "";
    }
  }

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
    canonicalRaw,
    generateId,
    now,
  });

  let quarantinePath: string | null = null;
  let note = "";
  let fileWritten = false;
  let canonicalWritten = false;

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

  function atomicWrite(target: string, identity: LocalIdentity): boolean {
    const payload = JSON.stringify({
      schema_version: LOCAL_IDENTITY_SCHEMA_VERSION,
      user_id: identity.user_id,
      install_id: identity.install_id,
      created_at: identity.created_at,
    });
    const tmpPath = `${target}.tmp`;
    writeFileSync(tmpPath, payload);
    renameSync(tmpPath, target);
    return true;
  }

  if (mayWrite) {
    try {
      fileWritten = atomicWrite(path, decision.identity);
    } catch (e) {
      note = `escrita atômica falhou (${e instanceof Error ? e.message : String(e)}); identidade adotada em memória, arquivo pendente`;
    }
  }

  // Estabelece a canônica da máquina no primeiro run (nenhuma existia): é o
  // que faz os PRÓXIMOS perfis adotarem os mesmos ids. Nunca sobrescreve uma
  // canônica existente; e quando o diretório resolvido É a canônica, não
  // grava duas vezes o mesmo arquivo.
  if (canonicalPath && canonicalRaw === null && canonicalPath !== path) {
    try {
      canonicalWritten = atomicWrite(canonicalPath, decision.identity);
    } catch (e) {
      note = note
        ? `${note}; canônica da máquina não gravada (${e instanceof Error ? e.message : String(e)})`
        : `canônica da máquina não gravada (${e instanceof Error ? e.message : String(e)})`;
    }
  }

  return { identity: decision.identity, decision, quarantinePath, fileWritten, canonicalWritten, canonicalPath, note };
}
