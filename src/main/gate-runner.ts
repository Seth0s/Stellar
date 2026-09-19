/**
 * Gate runner — o APP executa os gates declarados de uma task, como
 * subprocesso real, e persiste stdout/stderr/exit-code MEDIDOS.
 *
 * Problema que isto fecha (2026-09-19): quem RODAVA o gate era o próprio
 * agente implementador, e quem confiava no número era o orquestrador. Um
 * implementador reportou "373 passed, 1 failed" e o revisor reproduziu
 * 371 com 2-3 falhas — regressão escondida atrás de uma flake conhecida.
 * A partir daqui o número vem do processo, nunca do que um agente digitou.
 *
 * ESCOLHA DE EXECUÇÃO — spawn isolado (`child_process.spawn` com pipes),
 * NÃO `pty-registry.ts`. Medido nesta máquina em 2026-09-19, rodando um
 * comando que imprime um contador, um stderr distinto e sai com código 1:
 *
 *   - spawn isolado : exit code real 1; stdout e stderr SEPARADOS; o probe
 *     `{isTTY:false, color:null}` — runners emitem saída de máquina.
 *   - node-pty      : exit code real 1, mas stdout+stderr viram UM stream
 *     (`"...373 passed, 1 failed\r\na real stderr line\r\n"`), e o probe
 *     devolve `{isTTY:true, columns:80, color:8}` — vitest/tsc/phpunit
 *     detectam TTY e passam a colorir, desenhar progresso com `\r` e
 *     quebrar/truncar linha na largura do card. É exatamente a classe de
 *     mangling que torna um número reportado não confiável.
 *
 * Além disso, `pty-registry` é feito para um CARD interativo: exige um id
 * de card vivo, injeta a execução no buffer do terminal (aparece em
 * `list_cards`), não tem stderr separado e não devolve exit code sem o
 * ciclo de vida do `onExit`. Reusá-lo seria pagar tudo isso para obter
 * uma captura PIOR. O registry segue intocado.
 *
 * CONCORRÊNCIA — `withRepoGateLock` serializa qualquer execução de gate
 * contra o MESMO repositório (raiz do git do cwd), venha ela de tasks ou
 * cards diferentes. Dois `npx vitest run` concorrentes no mesmo working
 * tree não podem rodar ao mesmo tempo: rodar gate escreve em disco/banco/
 * cache, não é leitura. Lock em memória, por processo do app — que é o
 * escopo real do defeito medido (dois cards do MESMO app colhendo falha
 * um do outro; um sozinho dava 425/0). Um segundo processo Electron sobre
 * o mesmo userData é fora de escopo aqui, declarado, não fingido.
 *
 * LIMITE DE PERSISTÊNCIA — cada stream é retido pelo TAIL, até
 * `MAX_CAPTURE_BYTES`, com `stdoutBytes`/`stderrBytes` (o total REAL
 * visto) e `truncated`. O record é carimbado pelo app em `result_json`
 * (`gateRun`), o mesmo envelope que `failureKind` já usa, e um agente
 * NÃO pode forjá-lo: `stripAgentGateEvidence` remove a chave de qualquer
 * `update_task.result` antes de gravar.
 */

import { spawn, execFile, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { effectivePath } from "./user-env";

/** Chave do record de gate carimbado pelo app em `tasks.result_json`.
 * Mesmo lugar (e mesma classe de dono) de `failureKind`: o app observa,
 * o agente nunca declara. */
export const GATE_EVIDENCE_KEY = "gateRun";

/** Tail retido por stream. O exit code é a verdade; a saída é a prova.
 * 16 KiB cobre o resumo de uma suíte e o rodapé de um typecheck; o resto
 * fica contado em `*Bytes` para a truncagem ser honesta. */
export const MAX_CAPTURE_BYTES = 16 * 1024;

/** Teto de parede por gate. Uma suíte que trava é um gate que não passou
 * (o processo é morto e `timedOut` fica registrado) — nunca um gate que
 * segura o lock do repositório para sempre. */
export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60_000;

/** Raiz do git do cwd (`git rev-parse --show-toplevel`), ou `null` quando
 * o cwd não está num repositório (ou o git não respondeu no prazo). Não
 * adivinha: sem raiz, o lock cai no próprio cwd, ver `lockKeyFor`. */
export function resolveGitRoot(cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        if (err) return done(null);
        const root = stdout.trim();
        done(root.length > 0 ? resolve(root) : null);
      },
    );
  });
}

/** Chave do lock: a raiz do repo quando há uma, senão o cwd resolvido —
 * dois gates no mesmo diretório ainda serializam mesmo fora do git. */
export function lockKeyFor(gitRoot: string | null, cwd: string): string {
  return gitRoot ?? resolve(cwd);
}

const repoGates = new Map<string, Promise<void>>();

/**
 * Fila FIFO por chave (raiz do repositório). O `fn` de cada chamador roda
 * depois que o `fn` anterior ASSENTOU — sucesso ou falha, porque um gate
 * que falhou não pode travar os próximos (`prev.then(fn, fn)`).
 *
 * O `tail` guardado no Map engole a rejeição de propósito: quem espera na
 * fila não herda o erro do vizinho, e o retorno de cada chamada ainda é
 * o `run` real, com o erro real, para quem pediu. A entrada some quando o
 * último da fila assenta, para o Map não crescer por repositório visto.
 */
export function withRepoGateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoGates.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  repoGates.set(key, tail);
  void tail.then(() => {
    if (repoGates.get(key) === tail) repoGates.delete(key);
  });
  return run;
}

export type GateCommandEvidence = {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  startedAt: number;
  durationMs: number;
  /** Tail retido (≤ MAX_CAPTURE_BYTES), decodificado como UTF-8. */
  stdout: string;
  stderr: string;
  /** Total REAL visto por stream, antes de qualquer corte. */
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type GateRunEvidence = {
  taskId: string;
  /** cwd declarado na task (o que o lock recebeu). */
  requestedCwd: string;
  /** Raiz do git usada como cwd real, ou `null` se o cwd não era repo. */
  gitRoot: string | null;
  startedAt: number;
  finishedAt: number;
  /** `true` só quando TODO comando saiu com exit code 0. O veredito é o
   * exit code do processo — nunca um parse da saída. */
  ok: boolean;
  commands: GateCommandEvidence[];
};

export type GateSpawn = (command: string, options: SpawnOptions) => ReturnType<typeof spawn>;

export type RunTaskGatesInput = {
  taskId: string;
  cwd: string;
  gates: string[];
  timeoutMs?: number;
  /** Seam de teste — a produção passa o `spawn` real. */
  spawnFn?: GateSpawn;
  /** Seam de teste — a produção usa `effectivePath()`. */
  pathValue?: string;
};

const inFlightRuns = new Map<string, Promise<GateRunEvidence>>();

/**
 * Roda os gates declarados de uma task, serializados contra o mesmo
 * repositório. Se já existe uma execução em voo para a MESMA task,
 * devolve a mesma promessa (um agente que reporta duas vezes não
 * enfileira a suíte duas vezes).
 */
export function runTaskGates(input: RunTaskGatesInput): Promise<GateRunEvidence> {
  const existing = inFlightRuns.get(input.taskId);
  if (existing) return existing;
  const run = execute(input).finally(() => {
    inFlightRuns.delete(input.taskId);
  });
  inFlightRuns.set(input.taskId, run);
  return run;
}

async function execute(input: RunTaskGatesInput): Promise<GateRunEvidence> {
  const requestedCwd = resolve(input.cwd);
  const gitRoot = await resolveGitRoot(requestedCwd);
  const spawnCwd = gitRoot ?? requestedCwd;
  const spawnFn = input.spawnFn ?? (spawn as GateSpawn);
  const timeoutMs = input.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const env = { ...process.env, PATH: input.pathValue ?? effectivePath() };

  return withRepoGateLock(lockKeyFor(gitRoot, requestedCwd), async () => {
    // Dentro do lock de propósito: fora dele, `startedAt` seria o instante
    // do PEDIDO e `finishedAt - startedAt` incluiria a espera na fila do
    // repositório — um gate de 4s atrás de outro de 10min pareceria ter
    // durado 10min. Os tempos por comando sempre foram reais.
    const startedAt = Date.now();
    const commands: GateCommandEvidence[] = [];
    for (const command of input.gates) {
      commands.push(await runOne(command, { cwd: spawnCwd, env, timeoutMs, spawnFn }));
    }
    return {
      taskId: input.taskId,
      requestedCwd,
      gitRoot,
      startedAt,
      finishedAt: Date.now(),
      ok: commands.length > 0 && commands.every((c) => c.exitCode === 0),
      commands,
    };
  });
}

function runOne(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; spawnFn: GateSpawn },
): Promise<GateCommandEvidence> {
  return new Promise((done) => {
    const startedAt = Date.now();
    const out = new TailCollector(MAX_CAPTURE_BYTES);
    const err = new TailCollector(MAX_CAPTURE_BYTES);
    let timedOut = false;
    let settled = false;

    const child = opts.spawnFn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      // Grupo próprio no POSIX para o timeout derrubar também os filhos do
      // `npx`/shell, não só o processo de frente (órfão rodando a suíte).
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({
        command,
        exitCode,
        signal,
        timedOut,
        startedAt,
        durationMs: Date.now() - startedAt,
        stdout: out.toString(),
        stderr: err.toString(),
        stdoutBytes: out.seen,
        stderrBytes: err.seen,
        stdoutTruncated: out.seen > MAX_CAPTURE_BYTES,
        stderrTruncated: err.seen > MAX_CAPTURE_BYTES,
      });
    };

    child.on("error", (e) => {
      err.push(Buffer.from(`${String((e as Error).message)}\n`, "utf8"));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
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

/** Buffer de cauda limitado por bytes: guarda os ÚLTIMOS `max` bytes e
 * conta o total visto, para a truncagem ser declarada, não muda. */
class TailCollector {
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
      const head = this.chunks[0];
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

function parseResultObject(existingJson: string | null | undefined): Record<string, unknown> {
  if (!existingJson) return {};
  try {
    const parsed = JSON.parse(existingJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return { _raw: existingJson };
  } catch {
    return { _raw: existingJson };
  }
}

/** Carimba a execução MEDIDA pelo app em `result_json`, preservando as
 * demais chaves (result do agente, failureKind, lastRefusedReport). */
export function stampGateEvidenceJson(
  existingJson: string | null | undefined,
  evidence: GateRunEvidence,
): string {
  const base = parseResultObject(existingJson);
  base[GATE_EVIDENCE_KEY] = evidence;
  return JSON.stringify(base);
}

/** Lê o record de gate de um `result_json`; `null` se ausente/ilegível.
 * Deliberadamente tolerante: linha antiga não tem a chave, e isso é normal. */
export function gateEvidenceFromResultJson(resultJson: string | null | undefined): GateRunEvidence | null {
  const base = parseResultObject(resultJson);
  const value = base[GATE_EVIDENCE_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as GateRunEvidence;
}

/**
 * Repõe a evidência de gate que um `result_json` recém-mesclado perdeu.
 *
 * O contrato deste módulo é "o agente não pode forjar NEM APAGAR" o que o
 * app mediu. Forjar, o `stripAgentGateEvidence` acima já impede. Apagar
 * continuava possível: `mergeAgentResultJson` (failure-kind-decision.ts)
 * reconstrói o objeto a partir do payload do AGENTE e só preserva
 * explicitamente `failureKind`, então qualquer `update_task.result`
 * posterior descartava o `gateRun`. Este é o MESMO remédio que o
 * `failureKind` já tem, aplicado à evidência de gate:
 *   - o mesclado já traz uma evidência (o app acabou de carimbar uma
 *     medição nova) → é ela que fica, nunca a anterior;
 *   - senão, a do dono anterior é reposta.
 * Payload escalar/array/não-JSON (sem lugar para a chave) recebe o mesmo
 * envelope `{ value, gateRun }` que `mergeAgentResultJson` usa pro
 * `failureKind` — a evidência sobrevive à forma que o agente mandou.
 * `null`/vazio também: apagar por omissão não é um caminho.
 */
export function carryGateEvidence(
  existingJson: string | null | undefined,
  nextJson: string | null | undefined,
): string | null {
  const previous = gateEvidenceFromResultJson(existingJson);
  if (!previous) return nextJson ?? null;
  if (gateEvidenceFromResultJson(nextJson)) return nextJson ?? null;
  return attachGateEvidence(nextJson, previous);
}

function attachGateEvidence(json: string | null | undefined, evidence: GateRunEvidence): string {
  let parsed: unknown;
  let parsedOk = false;
  if (typeof json === "string" && json.length > 0) {
    try {
      parsed = JSON.parse(json);
      parsedOk = true;
    } catch {
      parsed = json;
    }
  }
  if (parsedOk && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return JSON.stringify({ ...(parsed as Record<string, unknown>), [GATE_EVIDENCE_KEY]: evidence });
  }
  return JSON.stringify({ value: parsedOk ? parsed : (parsed ?? null), [GATE_EVIDENCE_KEY]: evidence });
}

/**
 * Remove o record de gate de um `update_task.result` ANTES de gravá-lo —
 * a evidência é do app, e um agente não pode forjar nem apagar a que o app
 * mediu (apagar é fechado em `carryGateEvidence`, usado no mesmo merge).
 * Não-objeto (string/escalar/array) volta intocado: não há chave para
 * forjar, e `mergeAgentResultJson` já sabe envelopar.
 */
export function stripAgentGateEvidence(agentResult: unknown): unknown {
  if (agentResult === null || typeof agentResult !== "object" || Array.isArray(agentResult)) return agentResult;
  const copy: Record<string, unknown> = { ...(agentResult as Record<string, unknown>) };
  delete copy[GATE_EVIDENCE_KEY];
  return copy;
}
