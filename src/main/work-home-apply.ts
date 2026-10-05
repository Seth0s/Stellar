/**
 * CASA DE TRABALHO — o APLICADOR (A3a, BACKEND_V1.md §5.3).
 *
 * Executa o plano de `work-home-apply-decision.ts` no disco:
 *   - PRÉVIA: o plano já diz o que entra/muda/pendente/conflita; aqui só os
 *     atos confirmados são executados.
 *   - BACKUP DATADO: todo arquivo sobrescrito (ou removido) é copiado para
 *     `work-home-backup-<ts>/<tool>/<rel>` antes. Backup nunca é apagado.
 *   - ESCRITA ATÔMICA: tmp irmão + rename — um crash no meio não deixa um
 *     arquivo truncado no lugar do bom.
 *   - SEM APAGAR SEM MARCA: só a ação `remove`, que só vem de remoção
 *     EXPLÍCITA no manifesto, apaga. Ausência no pacote não apaga nada.
 *
 * Conflito sem escolha NÃO é resolvido sozinho: fica reportado para a UI
 * perguntar (§5.4). A escolha `both` escreve o remoto com sufixo, sem tocar no
 * local — a opção que nunca perde trabalho.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import {
  type WorkHomeApplyPlan,
  type WorkHomeApplyPlanItem,
  type WorkHomeConflictChoice,
  resolveWorkHomeConflict,
} from "./work-home-apply-decision";
import { isTemplatedContentPath } from "./work-home-tools";
import { expandPathValuesInText, type PathValueContext } from "./work-home-path-values";

export type WorkHomeAppliedFile = {
  path: string;
  targetPath: string;
  /** Destino do backup, `null` quando não havia arquivo a preservar. */
  backedUpTo: string | null;
};

export type WorkHomeApplyResult = {
  written: WorkHomeAppliedFile[];
  removed: WorkHomeAppliedFile[];
  keptLocal: string[];
  /** Conflitos que ficaram SEM escolha — a UI precisa perguntar. */
  conflicts: { path: string; targetPath: string }[];
  pending: { path: string; reason: string }[];
  warnings: string[];
  /** Diretório de backup criado nesta execução, `null` se nada foi sobrescrito. */
  backupDir: string | null;
};

export type ApplyWorkHomeInput = {
  plan: WorkHomeApplyPlan;
  blobs: ReadonlyMap<string, Uint8Array>;
  /** Escolha por caminho lógico; ausente = conflito não resolve sozinho. */
  choices?: Readonly<Record<string, WorkHomeConflictChoice>>;
  /** Raiz onde as pastas de backup datadas nascem. */
  backupRoot: string;
  /** Epoch-ms usado no nome da pasta datada e no sufixo de `both`. */
  now: number;
  /** Contexto para expandir `{home}`/`{project:<id>}` no conteúdo do settings
   *  filtrado. Ausente = grava o conteúdo como veio (só para quem não usa a
   *  reescrita de valores, como testes antigos). */
  pathValues?: PathValueContext;
};

/** sha256 de um arquivo, `null` se não existe / não é arquivo regular. */
export function sha256FileSync(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** `foo.md` + sufixo → `foo.remote-<sufixo>.md`. */
export function suffixedPath(target: string, suffix: string): string {
  const ext = extname(target);
  const base = ext === "" ? target : target.slice(0, -ext.length);
  return `${base}.remote-${suffix}${ext}`;
}

/**
 * Aplica o plano. Erros de I/O não abortam o resto: viram `warnings` e o item
 * simplesmente não é contado como aplicado — o resultado diz o que de fato
 * aconteceu, sem fingir sucesso.
 */
export function applyWorkHomePlan(input: ApplyWorkHomeInput): WorkHomeApplyResult {
  const choices = input.choices ?? {};
  const result: WorkHomeApplyResult = {
    written: [],
    removed: [],
    keptLocal: [],
    conflicts: [],
    pending: [],
    warnings: [],
    backupDir: null,
  };
  let backupCounter = 0;

  function ensureBackupDir(): string {
    if (result.backupDir === null) {
      const dir = join(input.backupRoot, `work-home-backup-${input.now}`);
      mkdirSync(dir, { recursive: true });
      result.backupDir = dir;
    }
    return result.backupDir;
  }

  /** Copia o arquivo existente para a pasta datada. */
  function backup(item: WorkHomeApplyPlanItem, target: string): string | null {
    if (!existsSync(target)) return null;
    const rel = item.relPath === "" ? target.split("/").pop() ?? "file" : item.relPath;
    const dest = join(ensureBackupDir(), item.tool, ...rel.split("/").filter((p) => p !== ""));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(target, dest);
    return dest;
  }

  function atomicWrite(target: string, bytes: Uint8Array, mode: number): void {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.work-home-tmp-${process.pid}-${backupCounter++}`;
    writeFileSync(tmp, bytes);
    try {
      chmodSync(tmp, mode);
    } catch {
      // Modo é informativo; não impede a escrita.
    }
    renameSync(tmp, target);
  }

  /** Expande `{home}`/`{project:<id>}` no CONTEÚDO do settings filtrado antes de
   *  gravar. `null` = um projeto referenciado não tem clone (não grava marcador). */
  function materialize(item: WorkHomeApplyPlanItem, bytes: Uint8Array): Uint8Array | null {
    if (!input.pathValues || !isTemplatedContentPath(item.path)) return bytes;
    const { text, unresolved } = expandPathValuesInText(Buffer.from(bytes).toString("utf-8"), input.pathValues);
    if (unresolved.length > 0) {
      result.warnings.push(`${item.path}: projeto sem clone local (${unresolved.join(", ")}) — conteúdo não gravado`);
      return null;
    }
    return Buffer.from(text, "utf-8");
  }

  function applyItem(item: WorkHomeApplyPlanItem): void {
    if (item.action === "pending") {
      result.pending.push({ path: item.path, reason: item.reason });
      return;
    }
    if (item.action === "unchanged" || item.action === "keep-local" || item.action === "noop") return;

    const target = item.targetPath;
    if (target === null) {
      result.pending.push({ path: item.path, reason: "sem alvo resolvido" });
      return;
    }

    if (item.action === "conflict") {
      const choice = choices[item.path];
      if (!choice) {
        result.conflicts.push({ path: item.path, targetPath: target });
        return;
      }
      const resolution = resolveWorkHomeConflict(choice, { suffix: String(input.now) });
      if (resolution.action === "keep-local") {
        result.keptLocal.push(item.path);
        return;
      }
      const raw = item.remoteSha !== null ? input.blobs.get(item.remoteSha) : undefined;
      if (!raw) {
        result.warnings.push(`${item.path}: conteúdo remoto ausente no pacote — conflito não resolvido`);
        return;
      }
      const bytes = materialize(item, raw);
      if (!bytes) return;
      if (resolution.action === "write-remote-suffixed") {
        const dest = suffixedPath(target, resolution.suffix);
        try {
          atomicWrite(dest, bytes, 0o644);
        } catch (e) {
          result.warnings.push(`${item.path}: falha ao escrever "${dest}" (${err(e)})`);
          return;
        }
        result.written.push({ path: item.path, targetPath: dest, backedUpTo: null });
        return;
      }
      // write-remote: sobrescreve o local (com backup).
      try {
        const backedUpTo = backup(item, target);
        atomicWrite(target, bytes, 0o644);
        result.written.push({ path: item.path, targetPath: target, backedUpTo });
      } catch (e) {
        result.warnings.push(`${item.path}: falha ao aplicar remoto (${err(e)})`);
      }
      return;
    }

    if (item.action === "remove") {
      // ÚNICO caminho que apaga — e só veio de remoção explícita no manifesto.
      try {
        const backedUpTo = backup(item, target);
        unlinkSync(target);
        result.removed.push({ path: item.path, targetPath: target, backedUpTo });
      } catch (e) {
        result.warnings.push(`${item.path}: falha ao remover (${err(e)})`);
      }
      return;
    }

    // add | update
    const raw = item.remoteSha !== null ? input.blobs.get(item.remoteSha) : undefined;
    if (!raw) {
      result.warnings.push(`${item.path}: conteúdo ausente no pacote — não escrito`);
      return;
    }
    const bytes = materialize(item, raw);
    if (!bytes) return;
    try {
      const backedUpTo = item.action === "update" ? backup(item, target) : null;
      atomicWrite(target, bytes, 0o644);
      result.written.push({ path: item.path, targetPath: target, backedUpTo });
    } catch (e) {
      result.warnings.push(`${item.path}: falha ao escrever (${err(e)})`);
    }
  }

  for (const item of input.plan.items) applyItem(item);

  return result;
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Remove um diretório de backup — só para chamadas explícitas (testes). O
 *  aplicador NUNCA remove backup sozinho (§5.3). */
export function removeBackupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
