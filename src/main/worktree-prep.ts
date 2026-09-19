/**
 * Aplicação da decisão de `worktree-isolation-decision.ts`: cria a git
 * worktree descartável e copia os caminhos que o `.gitignore` esconde e que
 * o projeto declarou precisar para rodar.
 *
 * Fronteira de I/O (git + fs) — a decisão fica no módulo puro, testável.
 *
 * Escolhas medidas/deliberadas:
 * - `--detach`: uma worktree em HEAD destacado nunca colide com o checkout
 *   da árvore principal nem com outra worktree (duas não podem ter a MESMA
 *   branch). É o mesmo `git worktree add <path> HEAD` que o manual do
 *   orquestrador (§10/§11) já manda usar à mão.
 * - Cópia funda (`cp` recursivo), nunca symlink da raiz declarada: symlinkar
 *   `vendor/` quebra o autoload do Composer (o `.env`/autoloader resolvem
 *   caminhos reais).
 * - Raiz curta por padrão (`/tmp/stellar-wt` no POSIX), pelo teto de 108
 *   bytes de socket (docs/ORCHESTRATION.md §15) — `/tmp` e não
 *   `os.tmpdir()`, que no macOS é um `/var/folders/…` longo.
 * - Cópia que falha no meio faz ROLLBACK da worktree inteira: uma árvore
 *   meio-povoada é pior que nenhuma, porque o gate rodaria contra um estado
 *   que não é nem o declarado nem o do repo.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  buildWorktreePath,
  parseWorktreeConfig,
  WORKTREE_CONFIG_REL_PATH,
  type WorktreeConfig,
} from "./worktree-isolation-decision";

const execFileAsync = promisify(execFile);

/** Raiz curta default — ver o doc do módulo sobre `/tmp` vs `os.tmpdir()`. */
export function defaultWorktreeRoot(): string {
  return process.platform === "win32" ? join(tmpdir(), "stellar-wt") : "/tmp/stellar-wt";
}

type GitResult = { code: number; stdout: string; stderr: string };

/** `git -C <cwd> …`, nunca lançando: o erro vira `code !== 0` com a saída
 * real, para a recusa nomear o motivo do git em vez de um "falhou". */
async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    if (err.code === "ENOENT") {
      return { code: 127, stdout: "", stderr: "git: command not found on PATH" };
    }
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: (err.stderr ?? err.message ?? "").toString(),
    };
  }
}

export type WorktreePrepResult =
  | {
      ok: true;
      /** Caminho da worktree NOVA — o `cwd` que o card deve receber. */
      path: string;
      /** Raiz do checkout de origem (toplevel do git), para rollback. */
      sourceRoot: string;
      /** Caminhos declarados e realmente copiados. */
      copied: string[];
      /** Declarados mas ausentes na origem (ausência é dado; não falha). */
      missing: string[];
    }
  | { ok: false; error: string };

/**
 * Prepara a worktree isolada. `sourceCwd` é o checkout de origem (o `cwd` do
 * request, ou o do card chamador); `root` é injetável para teste.
 *
 * Nunca lança: toda falha resolve em `{ ok: false, error }` com o motivo real.
 */
export async function prepareIsolatedWorktree(opts: {
  sourceCwd: string;
  root?: string;
}): Promise<WorktreePrepResult> {
  const sourceCwd = typeof opts.sourceCwd === "string" ? opts.sourceCwd.trim() : "";
  if (sourceCwd.length === 0) {
    return {
      ok: false,
      error:
        'isolation:"worktree" needs a source checkout — pass cwd (the repo to branch from), or call from a card that already has one',
    };
  }
  const top = await git(["rev-parse", "--show-toplevel"], sourceCwd);
  const sourceRoot = top.stdout.trim();
  if (top.code !== 0 || sourceRoot.length === 0) {
    return {
      ok: false,
      error: `isolation:"worktree" needs a git repository at "${sourceCwd}" (git rev-parse failed: ${top.stderr.trim() || "no output"})`,
    };
  }

  // Declaração POR PROJETO, lida da árvore de origem. Ausente = copia nada.
  const configPath = join(sourceRoot, WORKTREE_CONFIG_REL_PATH);
  let config: WorktreeConfig;
  if (existsSync(configPath)) {
    const parsed = parseWorktreeConfig(await readFile(configPath, "utf8"));
    if (!parsed.ok) return { ok: false, error: parsed.error };
    config = parsed.config;
  } else {
    config = { copy: [] };
  }

  // Precedência: override de teste > raiz declarada PELO PROJETO (curta e
  // executável — resolve o caso de `/tmp` noexec) > default curto.
  const root =
    opts.root && opts.root.trim().length > 0
      ? opts.root
      : (config.worktreeRoot ?? defaultWorktreeRoot());
  const built = buildWorktreePath({
    root,
    repoName: basename(sourceRoot),
    uniqueId: randomBytes(4).toString("hex"),
  });
  if (!built.ok) return { ok: false, error: built.error };

  await mkdir(root, { recursive: true });
  const add = await git(["worktree", "add", "--detach", built.path, "HEAD"], sourceRoot);
  if (add.code !== 0) {
    return {
      ok: false,
      error: `git worktree add failed: ${(add.stderr || add.stdout).trim() || `exit ${add.code}`}`,
    };
  }

  const copied: string[] = [];
  const missing: string[] = [];
  for (const rel of config.copy) {
    const src = join(sourceRoot, rel);
    if (!existsSync(src)) {
      missing.push(rel);
      continue;
    }
    const dest = join(built.path, rel);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest, { recursive: true, force: true });
      copied.push(rel);
    } catch (e) {
      await removeIsolatedWorktree({ sourceRoot, path: built.path });
      return {
        ok: false,
        error: `copied the worktree but failed on declared path "${rel}": ${e instanceof Error ? e.message : String(e)} — worktree rolled back`,
      };
    }
  }

  return { ok: true, path: built.path, sourceRoot, copied, missing };
}

/**
 * Remove a worktree — usada no rollback de uma preparação que falhou e na
 * recusa/expiração do consentimento (a worktree nunca deve sobreviver a um
 * card que não nasceu). Best-effort: nunca lança.
 */
export async function removeIsolatedWorktree(opts: {
  sourceRoot: string;
  path: string;
}): Promise<void> {
  const removed = await git(["worktree", "remove", "--force", opts.path], opts.sourceRoot);
  if (removed.code === 0) return;
  // Registro sumiu ou nunca foi gravado: apaga o diretório e poda as
  // referências mortas, para não sobrar worktree "fantasma" no `git worktree list`.
  try {
    await rm(opts.path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  await git(["worktree", "prune"], opts.sourceRoot);
}
