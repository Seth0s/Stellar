/**
 * CASA DE TRABALHO — a DECISÃO do aplicador, sem I/O (A3a, §5.3/§5.4).
 *
 * Duas decisões puras:
 *
 *   1. O PLANO DE PRÉVIA. Dado o pacote que chega, o manifesto BASE (a última
 *      revisão sincronizada) e o estado local, diz para cada arquivo: entra,
 *      muda, fica pendente (projeto sem clone) ou CONFLITA. Nada é escrito
 *      aqui — quem escreve é `work-home-apply.ts`.
 *
 *   2. O CONFLITO por arquivo (§5.4). Mudou só de um lado → aplica; mudou dos
 *      dois → pergunta. A escolha é `local`, `remote` ou `both` (o remoto vai
 *      com sufixo, sem tocar no local).
 *
 * O estado local entra por uma função `shaOf` injetada — é o que mantém a
 * tabela de decisão testável sem tocar o disco. A casca com I/O passa
 * `sha256OfFileSync`.
 *
 * Invariante de segurança (§5.3): o aplicador NUNCA apaga por ausência. Só uma
 * marca EXPLÍCITA de remoção no manifesto pode virar `remove`, e ainda assim o
 * arquivo tem de estar igual à base (senão é conflito).
 */

import {
  HOME_MARKER,
  markerTool,
  projectIdOf,
  relPathOf,
  type WorkHomeManifest,
  type WorkHomePackage,
  type WorkHomeTool,
  manifestByPath,
} from "./work-home-manifest";
import { encodeClaudeProjectDir, relWithin, resolveProjectLocalDir, toPosix, type ProjectClone } from "./work-home-remap";
import { isTemplatedContentPath } from "./work-home-tools";
import { projectRefsInText } from "./work-home-path-values";
import { join } from "node:path";

/** Ação de um arquivo que CHEGA (existe no pacote remoto). */
export type WorkHomeFileAction = "add" | "update" | "unchanged" | "keep-local" | "conflict";
/** Ação de um arquivo marcado para REMOÇÃO explícita. */
export type WorkHomeRemovalAction = "remove" | "keep-local" | "conflict" | "noop";

/**
 * Tabela de decisão por arquivo (§5.4). `base == null` = nunca sincronizado.
 * "Mudou de um lado → aplica; dos dois → conflito."
 *
 *   base      local     remote    ação
 *   null      null      X         add
 *   null      ==remote  remote    unchanged
 *   null      !=remote  remote    conflict (dois "add" diferentes)
 *   B         ==remote  remote    unchanged
 *   B         ==B       !=B       update (só o remoto mudou)
 *   B         !=B       ==B       keep-local (só o local mudou)
 *   B         null      !=B       conflict (apagado local, mudado remoto)
 *   B         !=remote  !=B       conflict (os dois mudaram)
 */
export function decideWorkHomeFileAction(input: {
  baseSha: string | null;
  localSha: string | null;
  remoteSha: string;
}): WorkHomeFileAction {
  const { baseSha, localSha, remoteSha } = input;
  if (localSha !== null && localSha === remoteSha) return "unchanged";
  if (baseSha === null) return localSha === null ? "add" : "conflict";
  if (baseSha === remoteSha) return "keep-local";
  if (localSha === baseSha) return "update";
  return "conflict";
}

/**
 * Tabela de remoção. Sem base não há prova de que o arquivo era do conjunto
 * sincronizado — apagar seria destruição de dado local (§5.3), então ficamos
 * com o local e dizemos por quê.
 */
export function decideWorkHomeRemoval(input: {
  baseSha: string | null;
  localSha: string | null;
}): WorkHomeRemovalAction {
  if (input.localSha === null) return "noop";
  if (input.baseSha === null) return "keep-local";
  if (input.localSha === input.baseSha) return "remove";
  return "conflict";
}

export type WorkHomeConflictChoice = "local" | "remote" | "both";

export type WorkHomeConflictResolution =
  | { action: "keep-local" }
  | { action: "write-remote" }
  | { action: "write-remote-suffixed"; suffix: string };

/**
 * Traduz a escolha da pessoa para uma ação. `both` escreve o remoto AO LADO do
 * local com o sufixo dado (timestamp), sem sobrescrever nada — é a única opção
 * que nunca perde trabalho.
 */
export function resolveWorkHomeConflict(
  choice: WorkHomeConflictChoice,
  ctx: { suffix: string },
): WorkHomeConflictResolution {
  if (choice === "local") return { action: "keep-local" };
  if (choice === "remote") return { action: "write-remote" };
  return { action: "write-remote-suffixed", suffix: ctx.suffix };
}

export type WorkHomeApplyTarget =
  | { kind: "resolved"; absPath: string }
  | { kind: "pending"; reason: "unknown-tool-root" | "unresolved-project" | "non-portable" | "unsafe-path" };

export type WorkHomeTargetContext = {
  toolRoots: Partial<Record<WorkHomeTool, string>>;
  homeDir: string;
  projectClones: readonly ProjectClone[];
};

/**
 * A relative path is unsafe when it is absolute, carries a backslash or a NUL,
 * or has any empty, `.` or `..` segment. The server already rejects `..`, but
 * the team base is applied inside every member's home, so the app refuses it on
 * its own instead of trusting the sender.
 */
function unsafeRelPath(rel: string): boolean {
  if (rel === "") return false;
  if (rel.startsWith("/") || rel.startsWith("\\")) return true;
  if (rel.includes("\\") || rel.includes("\0")) return true;
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return true;
    if (/^[A-Za-z]:$/.test(segment)) return true;
  }
  return false;
}

/** True when `absPath` stays inside `root` (relative, with no leading `..`). */
function staysWithin(root: string, absPath: string): boolean {
  return relWithin(toPosix(root), toPosix(absPath)) !== null;
}

/**
 * Joins a validated relative path onto a root and proves the result stays
 * inside the root. A rejected path becomes a pending `unsafe-path`, never a
 * write.
 */
function resolveWithin(root: string, rel: string): WorkHomeApplyTarget {
  if (unsafeRelPath(rel)) return { kind: "pending", reason: "unsafe-path" };
  const absPath = rel === "" ? root : join(root, ...rel.split("/"));
  if (!staysWithin(root, absPath)) return { kind: "pending", reason: "unsafe-path" };
  return { kind: "resolved", absPath };
}

/**
 * Resolves the ABSOLUTE local path of a logical path. An unresolved project
 * (no clone) and a missing tool root do NOT become an invented path — they
 * become a pending item with its reason. A path that could escape the root
 * (traversal, backslash, absolute) is refused as `unsafe-path` even after the
 * team prefix.
 *
 * Claude project memory (`{project:<id>}/memory/x`) goes back to the Claude
 * directory: `<claude root>/projects/<encoded-cwd>/memory/x`.
 */
export function resolveWorkHomeTarget(logicalPath: string, ctx: WorkHomeTargetContext): WorkHomeApplyTarget {
  const projectId = projectIdOf(logicalPath);
  if (projectId !== null) {
    const claudeRoot = ctx.toolRoots.claude;
    if (!claudeRoot) return { kind: "pending", reason: "unknown-tool-root" };
    const localRoot = resolveProjectLocalDir(projectId, ctx.projectClones);
    if (localRoot === null) return { kind: "pending", reason: "unresolved-project" };
    const rel = relPathOf(logicalPath);
    const encoded = encodeClaudeProjectDir(localRoot);
    if (unsafeRelPath(rel) || unsafeRelPath(encoded)) return { kind: "pending", reason: "unsafe-path" };
    const base = join(claudeRoot, "projects", encoded);
    const absPath = rel === "" ? base : join(base, ...rel.split("/"));
    if (!staysWithin(claudeRoot, absPath)) return { kind: "pending", reason: "unsafe-path" };
    return { kind: "resolved", absPath };
  }

  const tool = markerTool(logicalPath);
  if (tool !== null) {
    const root = ctx.toolRoots[tool];
    if (!root) return { kind: "pending", reason: "unknown-tool-root" };
    return resolveWithin(root, relPathOf(logicalPath));
  }

  if (logicalPath === HOME_MARKER || logicalPath.startsWith(`${HOME_MARKER}/`)) {
    return resolveWithin(ctx.homeDir, relPathOf(logicalPath));
  }

  // Absolute path from the origin: not portable, never applied.
  return { kind: "pending", reason: "non-portable" };
}

export type WorkHomeApplyPlanItem = {
  /** Caminho lógico; chave de conflito e de escolha. */
  path: string;
  tool: WorkHomeTool;
  /** Caminho lógico sem o marcador — usado no backup. */
  relPath: string;
  action: WorkHomeFileAction | WorkHomeRemovalAction | "pending";
  targetPath: string | null;
  localSha: string | null;
  remoteSha: string | null;
  baseSha: string | null;
  reason: string;
};

export type WorkHomeApplyPlan = {
  items: WorkHomeApplyPlanItem[];
  summary: {
    add: number;
    update: number;
    unchanged: number;
    keepLocal: number;
    conflict: number;
    pending: number;
    remove: number;
  };
};

export type PlanWorkHomeInput = {
  incoming: WorkHomePackage;
  base: WorkHomeManifest | null;
  toolRoots: Partial<Record<WorkHomeTool, string>>;
  homeDir: string;
  projectClones: readonly ProjectClone[];
  /** sha256 do conteúdo local, `null` se ausente. Injetado (sem I/O aqui). */
  shaOf: (absPath: string) => string | null;
};

function itemFor(input: {
  source: { tool: WorkHomeTool; path: string };
  action: WorkHomeApplyPlanItem["action"];
  target: WorkHomeApplyTarget;
  localSha: string | null;
  remoteSha: string | null;
  baseSha: string | null;
  reason: string;
}): WorkHomeApplyPlanItem {
  return {
    path: input.source.path,
    tool: input.source.tool,
    relPath: relPathOf(input.source.path),
    action: input.action,
    targetPath: input.target.kind === "resolved" ? input.target.absPath : null,
    localSha: input.localSha,
    remoteSha: input.remoteSha,
    baseSha: input.baseSha,
    reason: input.reason,
  };
}

const PENDING_REASON: Record<Extract<WorkHomeApplyTarget, { kind: "pending" }>["reason"], string> = {
  "unknown-tool-root": "tool root not provided",
  "unresolved-project": "project without a local clone — pending",
  "non-portable": "absolute path from the origin — not portable",
  "unsafe-path": "path could escape the root — refused",
};

/**
 * Monta o plano de prévia. Puro: o estado local chega por `shaOf`. Pendências
 * (projeto sem clone, raiz ausente, caminho absoluto) aparecem com `targetPath
 * null` e NÃO são aplicadas.
 */
export function planWorkHomeApply(input: PlanWorkHomeInput): WorkHomeApplyPlan {
  const baseMap = manifestByPath(input.base);
  const ctx: WorkHomeTargetContext = {
    toolRoots: input.toolRoots,
    homeDir: input.homeDir,
    projectClones: input.projectClones,
  };
  const items: WorkHomeApplyPlanItem[] = [];
  const summary = { add: 0, update: 0, unchanged: 0, keepLocal: 0, conflict: 0, pending: 0, remove: 0 };

  for (const entry of input.incoming.manifest.entries) {
    const target = resolveWorkHomeTarget(entry.path, ctx);
    const baseSha = baseMap.get(entry.path)?.sha256 ?? null;
    if (target.kind === "pending") {
      summary.pending++;
      items.push(
        itemFor({
          source: entry,
          action: "pending",
          target,
          localSha: null,
          remoteSha: entry.sha256,
          baseSha,
          reason: PENDING_REASON[target.reason],
        }),
      );
      continue;
    }
    const localSha = input.shaOf(target.absPath);
    let action: WorkHomeApplyPlanItem["action"] = decideWorkHomeFileAction({ baseSha, localSha, remoteSha: entry.sha256 });
    let reason: string = action;

    // A filtered settings that carries `{project:<id>}` without a local clone:
    // the path INSIDE the content cannot be materialized, so the file stays
    // PENDING (the file target resolves, but the content does not).
    if (action !== "unchanged" && isTemplatedContentPath(entry.path)) {
      const blob = input.incoming.blobs.get(entry.sha256);
      const refs = blob ? projectRefsInText(Buffer.from(blob).toString("utf-8")) : [];
      const unresolved = refs.filter((id) => resolveProjectLocalDir(id, input.projectClones) === null);
      if (unresolved.length > 0) {
        action = "pending";
        reason = `settings referencia projeto sem clone local: ${unresolved.join(", ")}`;
      }
    }

    if (action === "add") summary.add++;
    else if (action === "update") summary.update++;
    else if (action === "unchanged") summary.unchanged++;
    else if (action === "keep-local") summary.keepLocal++;
    else if (action === "conflict") summary.conflict++;
    else summary.pending++;
    items.push(
      itemFor({
        source: entry,
        action,
        target,
        localSha,
        remoteSha: entry.sha256,
        baseSha,
        reason,
      }),
    );
  }

  for (const removedPath of input.incoming.manifest.removals) {
    // A remoção precisa de uma entrada de origem para saber a ferramenta; sem
    // isso, é ignorada (não apagamos no escuro).
    const known = baseMap.get(removedPath);
    if (!known) continue;
    const target = resolveWorkHomeTarget(removedPath, ctx);
    if (target.kind === "pending") {
      summary.pending++;
      items.push(
        itemFor({
          source: { tool: known.tool, path: removedPath },
          action: "pending",
          target,
          localSha: null,
          remoteSha: null,
          baseSha: known.sha256,
          reason: PENDING_REASON[target.reason],
        }),
      );
      continue;
    }
    const localSha = input.shaOf(target.absPath);
    const action = decideWorkHomeRemoval({ baseSha: known.sha256, localSha });
    if (action === "noop") continue;
    if (action === "remove") summary.remove++;
    else if (action === "keep-local") summary.keepLocal++;
    else summary.conflict++;
    items.push(
      itemFor({
        source: { tool: known.tool, path: removedPath },
        action,
        target,
        localSha,
        remoteSha: null,
        baseSha: known.sha256,
        reason: action === "remove" ? "remoção explícita confirmada" : action,
      }),
    );
  }

  return { items, summary };
}

/** Itens que ainda precisam de escolha (conflitos sem decisão). */
export function unresolvedConflicts(
  plan: WorkHomeApplyPlan,
  choices: Readonly<Record<string, WorkHomeConflictChoice>>,
): WorkHomeApplyPlanItem[] {
  return plan.items.filter((item) => item.action === "conflict" && !choices[item.path]);
}
