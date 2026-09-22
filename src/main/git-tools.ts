import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
// O MESMO coletor de cabeça do git capture (task 56604aca): a saída de uma
// verificação informa pelo COMEÇO, e a escolha fica num dono só.
import { HeadCollector, MAX_CAPTURE_BYTES } from "./gate-runner";
import { planSliceVerification, type SliceEntry, type SlicePlan } from "./slice-verify-plan";
import { countLines } from "./fs-tools";

const execFileP = promisify(execFile);

export type GitEntry = { path: string; status: string; insertions: number; deletions: number };
export type GitStatus =
  | { repo: false }
  | { repo: true; branch: string; insertions: number; deletions: number; entries: GitEntry[] };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function parsePorcelain(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    let rest = line.slice(3);
    if (rest.includes(" -> ")) rest = rest.split(" -> ")[1];
    map.set(rest.trim(), status);
  }
  return map;
}

function parseNumstat(output: string, into: Map<string, { insertions: number; deletions: number }>) {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [ins, del, path] = line.split("\t");
    if (!path) continue;
    const insertions = ins === "-" ? 0 : Number(ins);
    const deletions = del === "-" ? 0 : Number(del);
    const prior = into.get(path) ?? { insertions: 0, deletions: 0 };
    into.set(path, { insertions: prior.insertions + insertions, deletions: prior.deletions + deletions });
  }
}

/**
 * Replicates CentralByte's real git-status sequence: rev-parse --show-toplevel
 * (repo detection) -> rev-parse --abbrev-ref HEAD (branch) -> status --porcelain
 * -uall -> diff --numstat HEAD, falling back to diff --numstat + diff --cached
 * --numstat combined when HEAD doesn't exist yet (fresh repo, no commits).
 */
export async function gitStatus(cwd: string): Promise<GitStatus> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return { repo: false };
  }

  // rev-parse --abbrev-ref HEAD fails on an unborn branch (fresh repo, no
  // commits yet) — branch --show-current works in that case too.
  let branch: string;
  try {
    branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    branch = (await git(root, ["branch", "--show-current"])).trim();
  }
  const statusMap = parsePorcelain(await git(root, ["status", "--porcelain=v1", "-uall"]));

  const numstat = new Map<string, { insertions: number; deletions: number }>();
  try {
    parseNumstat(await git(root, ["diff", "--numstat", "HEAD"]), numstat);
  } catch {
    parseNumstat(await git(root, ["diff", "--numstat"]), numstat);
    parseNumstat(await git(root, ["diff", "--cached", "--numstat"]), numstat);
  }

  const entries: GitEntry[] = [];
  for (const [path, status] of statusMap) {
    const counts = numstat.get(path);
    if (counts) {
      entries.push({ path, status, insertions: counts.insertions, deletions: counts.deletions });
      continue;
    }
    let insertions = 0;
    if (status === "??") {
      try {
        insertions = await countLines(root, path);
      } catch {
        insertions = 0;
      }
    }
    entries.push({ path, status, insertions, deletions: 0 });
  }

  const insertions = entries.reduce((sum, e) => sum + e.insertions, 0);
  const deletions = entries.reduce((sum, e) => sum + e.deletions, 0);
  return { repo: true, branch, insertions, deletions, entries };
}

// ---------------------------------------------------------------------------
// VERIFICAÇÃO DE UMA FATIA EM ÁRVORE LIMPA (task 56604aca, fase 1) — o shell.
//
// O que ele responde, e o limite do que responde: "este CONJUNTO de arquivos
// compila sozinho?" — uma condição NECESSÁRIA, nunca "o meu trabalho compila".
// A fatia é por ARQUIVO e leva junto qualquer hunk de terceiro nesses arquivos
// (o §11 passo 1 do ORCHESTRATION.md classifica por CONTEÚDO, e é mais fino que
// isto); a tela é que diz isso ao humano, não este módulo.
//
// TODA ESCRITA ACONTECE NO WORKTREE. Medido: `git add -N` toca o índice, e o
// índice do worktree é próprio — dentro dele a árvore do dono fica com ZERO
// rastro. Este módulo nunca escreve no repositório do dono.
// ---------------------------------------------------------------------------

export type SliceStepOutcome = {
  kind: SlicePlan["steps"][number]["kind"];
  /** A linha da fatia a que o passo pertence (`null` = infraestrutura). */
  file: string | null;
  /** A linha legível do comando — é ela que o modo ORIENTADO mostra. */
  command: string;
  exitCode: number | null;
  ok: boolean;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
};

export type SliceVerdict =
  /** Os gates declarados rodaram e passaram. */
  | "compila"
  /** Rodaram e algum falhou. */
  | "nao-compila"
  /** A fatia não chegou a ser montada (worktree/symlink/apply), ou não havia
   * gate nenhum declarado: NÃO se confunde com "não compila". */
  | "nao-montou";

export type SliceVerifyOutcome = {
  verdict: SliceVerdict;
  worktree: string;
  routes: SlicePlan["routes"];
  steps: SliceStepOutcome[];
  /** A limpeza rodou (o worktree não existe mais). */
  cleaned: boolean;
  /** Falha da limpeza, se houve — nunca engolida: worktree órfão é dor. */
  cleanupError: string | null;
  /** Recusa ANTES de executar nada (worktree dentro do repo, por exemplo). */
  refused: string | null;
};

export type SliceSpawnFn = (
  argv: string[],
  cwd: string,
  opts: { stdoutFile: string | null },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

/**
 * O spawn real. `stdoutFile` (o `collect-patch`) manda o stdout para o ARQUIVO
 * em vez de retê-lo na memória: um patch binário ou grande não pode depender de
 * buffer nem de teto — e é justamente ele que vira a fatia.
 */
function defaultSliceSpawn(
  argv: string[],
  cwd: string,
  opts: { stdoutFile: string | null },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false });
    const out = new HeadCollector(MAX_CAPTURE_BYTES);
    const err = new HeadCollector(MAX_CAPTURE_BYTES);
    const sink = opts.stdoutFile ? createWriteStream(opts.stdoutFile) : null;
    child.stdout.on("data", (chunk: Buffer) => (sink ? sink.write(chunk) : out.push(chunk)));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e: Error) => done({ exitCode: null, stdout: out.toString(), stderr: String(e) }));
    child.on("close", (code: number | null) => {
      if (sink) sink.end(() => done({ exitCode: code, stdout: "", stderr: err.toString() }));
      else done({ exitCode: code, stdout: out.toString(), stderr: err.toString() });
    });
  });
}

/** Onde a verificação monta o worktree. Sempre fora do repo — o guarda abaixo
 * recusa o contrário (um worktree dentro do repo sujaria a própria árvore que
 * se quer isolar). */
export function makeSliceWorktreePath(): string {
  return mkdtempSync(join(tmpdir(), "stellar-fatia-"));
}

/**
 * Executa o plano. A LIMPEZA SAI SEMPRE, inclusive quando um gate falha ou o
 * passo anterior explode — e falha de limpeza é REPORTADA, nunca engolida.
 */
export async function runSlicePlan(
  plan: SlicePlan,
  opts: { spawnFn?: SliceSpawnFn } = {},
): Promise<SliceVerifyOutcome> {
  const spawnFn = opts.spawnFn ?? defaultSliceSpawn;
  const refused =
    resolve(plan.worktree).startsWith(`${resolve(plan.repoRoot)}/`) ||
    resolve(plan.worktree) === resolve(plan.repoRoot)
      ? "worktree dentro do repositorio: a verificacao isola uma copia, e escrever dentro do repo sujaria a arvore que se quer proteger"
      : null;
  if (refused) {
    return { verdict: "nao-montou", worktree: plan.worktree, routes: plan.routes, steps: [], cleaned: true, cleanupError: null, refused };
  }

  const steps: SliceStepOutcome[] = [];
  let cleanupError: string | null = null;
  let cleaned = false;
  let mounted = true;
  const cleanupStep = plan.steps.find((s) => s.kind === "cleanup");

  try {
    for (const step of plan.steps) {
      if (step.kind === "cleanup") continue; // sempre no finally
      const startedAt = Date.now();
      const res = await spawnFn(step.argv, step.cwd, { stdoutFile: step.outFile ?? null });
      const ok = res.exitCode === 0;
      steps.push({
        kind: step.kind,
        file: step.file,
        command: step.argv.join(" "),
        exitCode: res.exitCode,
        ok,
        stdoutTail: res.stdout,
        stderrTail: res.stderr,
        durationMs: Date.now() - startedAt,
      });
      if (!ok && step.kind !== "gate") {
        // A fatia não chegou a existir: parar aqui é mais honesto que rodar
        // gates num worktree pela metade e chamar o resultado de "não compila".
        mounted = false;
        break;
      }
    }
  } finally {
    if (cleanupStep) {
      try {
        const res = await spawnFn(cleanupStep.argv, cleanupStep.cwd, { stdoutFile: null });
        cleaned = res.exitCode === 0;
        if (!cleaned) cleanupError = res.stderr || `exit ${res.exitCode}`;
      } catch (err) {
        cleaned = false;
        cleanupError = err instanceof Error ? err.message : String(err);
      }
      // ÚLTIMA REDE — disparada pelo FATO MEDIDO (`!cleaned`), nunca pela forma
      // como a falha chegou. A versão anterior só a disparava dentro do `catch`,
      // e o `catch` era CÓDIGO MORTO no caminho real: `defaultSliceSpawn` não
      // LANÇA em `git worktree remove` saindo 128 — ele RESOLVE com o exit code
      // (só `child.on("error")` é que resolve com `exitCode: null`). Medido na
      // 2ª rodada com um spawn da forma da produção: o diretório do worktree
      // ficava no disco e `cleaned` saía `false` calado sobre o vazamento.
      //
      // Só se chega aqui depois da recusa de worktree DENTRO do repo (o `return`
      // acima): esta remoção forçada nunca aponta para dentro da árvore do dono.
      if (!cleaned) {
        try {
          rmSync(plan.worktree, { recursive: true, force: true });
          // O diretório saiu; o REGISTRO do worktree no `.git` pode ficar (é o
          // que o `git worktree prune` limpa, e não se roda git destrutivo por
          // conta própria aqui). Dito no erro, não escondido — e `cleaned`
          // continua `false`, que é a verdade: o `worktree remove` falhou.
          cleanupError = `${cleanupError} · diretório removido à força do disco (o registro no .git pode ficar)`;
        } catch (rmErr) {
          cleanupError = `${cleanupError} · E a remoção forçada do diretório falhou: ${
            rmErr instanceof Error ? rmErr.message : String(rmErr)
          }`;
        }
      }
    }
  }

  const gates = steps.filter((s) => s.kind === "gate");
  const verdict: SliceVerdict = !mounted
    ? "nao-montou"
    : gates.length === 0
      ? "nao-montou"
      : gates.every((g) => g.ok)
        ? "compila"
        : "nao-compila";
  return { verdict, worktree: plan.worktree, routes: plan.routes, steps, cleaned, cleanupError, refused: null };
}

/** O plano pronto a partir do status do repo — a única fábrica que o IPC usa. */
export function buildSlicePlan(input: {
  repoRoot: string;
  entries: readonly SliceEntry[];
  gates: readonly string[];
}): { plan: SlicePlan; worktree: string } {
  const worktree = makeSliceWorktreePath();
  const plan = planSliceVerification({
    repoRoot: input.repoRoot,
    worktree,
    patchFile: join(worktree, "..", `${worktree.split("/").pop()}.patch`),
    entries: input.entries,
    gates: input.gates,
  });
  return { plan, worktree };
}
