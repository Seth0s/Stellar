/**
 * `gate-lock` / `run_locked` (task ff24b36d) — o AGENTE roda um comando PESADO
 * através do MESMO lock que serializa os gates do app.
 *
 * POR QUE NÃO É UM GATE: um gate é shell DECLARADO na task e rodado pelo APP
 * sob confinamento (`gate-runner.ts`). Aqui o comando é do PRÓPRIO agente —
 * ele já pode digitá-lo no seu terminal — e o que falta não é confinamento, é
 * SERIALIZAÇÃO: `acbridge gate-lock -- npm run e2e` garante que este comando
 * não concorre com outro comando pesado no mesmo repositório (ou na máquina,
 * com `--scope machine`).
 *
 * POR ISSO NÃO TEM SANDBOX: o caso de uso medido (e2e/Lighthouse) precisa de
 * `$HOME`, de temp próprio e da rede QUE O AGENTE JÁ TEM. Confiná-lo quebraria
 * justamente o comando que se quer serializar. O que este caminho NÃO faz é
 * aumentar privilégio: o comando roda no cwd do chamador, com o ambiente
 * efetivo do app, e é o comando do chamador. (O gate do app continua sendo
 * `gate-runner.ts`, confinado e recusando sem `bwrap`.)
 *
 * LIMITE DECLARADO: `bash -lc` no host, como a CLI do próprio agente faria. O
 * que este módulo acrescenta é a FILA, não um shell novo.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { effectivePath } from "./user-env";
import { DEFAULT_GATE_TIMEOUT_MS, lockKeyFor, resolveGitRoot } from "./gate-runner";
import { acquireGateLock, gateLockKey, type GateLockHolder, type GateLockScope } from "./gate-lock";

/** Mesmo teto de captura do gate-runner: a saída é a prova, e ela é retida
 * pela CAUDA (o resumo de uma suíte é o fim). */
export const LOCKED_CAPTURE_BYTES = 16 * 1024;

export type LockedSpawn = (file: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;

export type RunLockedInput = {
  command: string;
  /** cwd do chamador — onde o comando roda e o que decide a chave do lock. */
  cwd: string;
  scope: GateLockScope;
  timeoutMs?: number;
  holder: GateLockHolder;
  /** Seam de teste — a produção usa o `spawn` real. */
  spawnFn?: LockedSpawn;
  /** Seam de teste — a produção usa `effectivePath()`. */
  pathValue?: string;
};

export type RunLockedEvidence = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  /** Espera na fila até obter o lock. 0 = entrou direto. */
  waitedMs: number;
  /** Quem segurava o lock quando este chamador entrou na fila. */
  holderWhileWaiting: GateLockHolder | null;
  positionAtRequest: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cwd: string;
  gitRoot: string | null;
  scope: GateLockScope;
  /** Chave do lock usada (`machine` ou a raiz do repo). */
  lockKey: string;
};

class Tail {
  private chunks: Buffer[] = [];
  private kept = 0;
  seen = 0;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.seen += chunk.length;
    this.chunks.push(chunk);
    this.kept += chunk.length;
    while (this.kept > this.max && this.chunks.length > 0) {
      const overflow = this.kept - this.max;
      const head = this.chunks[0]!;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.kept -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.kept -= overflow;
      }
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid);
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Já saiu entre o timer e o kill — o `close` real resolve.
  }
}

/** Como o comando entra no shell do host. POSIX: `bash -lc` (login shell, o
 * mesmo que o card do agente usaria). Windows: `cmd /d /s /c`. */
function shellArgv(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { file: "bash", args: ["-lc", command] };
}

export async function runLockedCommand(input: RunLockedInput): Promise<RunLockedEvidence> {
  const requestedCwd = resolve(input.cwd);
  const gitRoot = await resolveGitRoot(requestedCwd);
  const lockKey = gateLockKey(input.scope, lockKeyFor(gitRoot, requestedCwd));
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_GATE_TIMEOUT_MS;
  const spawnFn = input.spawnFn ?? (spawn as LockedSpawn);
  const env = { ...process.env, PATH: input.pathValue ?? effectivePath() };
  const { file, args } = shellArgv(input.command);

  const acquisition = await acquireGateLock(lockKey, input.holder);
  const startedAt = Date.now();
  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      stdout: Tail;
      stderr: Tail;
    }>((done) => {
      const out = new Tail(LOCKED_CAPTURE_BYTES);
      const err = new Tail(LOCKED_CAPTURE_BYTES);
      let timedOut = false;
      let settled = false;
      const child = spawnFn(file, args, {
        cwd: requestedCwd,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => out.push(c));
      child.stderr?.on("data", (c: Buffer) => err.push(c));
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done({ exitCode, signal, timedOut, stdout: out, stderr: err });
      };
      child.on("error", (e) => {
        err.push(Buffer.from(`${String((e as Error).message)}\n`, "utf8"));
        finish(null, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: Date.now() - startedAt,
      waitedMs: acquisition.waitedMs,
      holderWhileWaiting: acquisition.holderWhileWaiting,
      positionAtRequest: acquisition.positionAtRequest,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      stdoutBytes: result.stdout.seen,
      stderrBytes: result.stderr.seen,
      stdoutTruncated: result.stdout.seen > LOCKED_CAPTURE_BYTES,
      stderrTruncated: result.stderr.seen > LOCKED_CAPTURE_BYTES,
      cwd: requestedCwd,
      gitRoot,
      scope: input.scope,
      lockKey,
    };
  } finally {
    // Sempre libera — inclusive quando o processo do comando morre (o `close`
    // resolve o Promise e caímos aqui). Um comando morto não pode segurar o
    // lock nem a fila.
    acquisition.release();
  }
}
