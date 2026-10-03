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
 * SANDBOX (2026-09-19) — achado de segurança do reviewer B (task
 * 30d858c5): os `gates` de uma task são shell de autoria do AGENTE
 * (gravável por create_task/update_task via MCP, por qualquer card) e
 * rodavam com `shell: true` no host, sem confinamento e sem consentimento —
 * o caminho contornava os dois controles que o resto do app já tinha (a
 * tool `bash` do chat RECUSA sem bubblewrap; um card de terminal é
 * consent-gated). Agora cada comando roda DENTRO do mesmo sandbox
 * `bubblewrap` do `bash` do chat (`sandbox.ts`): host legível, só a raiz do
 * repo gravável, `$HOME`/`/tmp` mascarados, namespaces separados; e o spawn
 * no host é `(file, args)` SEM shell — não há onde passar o comando cru.
 * Quando não há bwrap, o gate NÃO roda: a evidência registra a recusa por
 * comando (`exitCode: null` + o motivo) e o run fica `ok:false` — nunca um
 * fallback silencioso para execução direta.
 *
 * Por que não chamar `runSandboxedBash` direto: aquele wrapper junta
 * stdout+stderr num só texto e tem timeout fixo de 60s, o que destruiria a
 * evidência que este módulo existe para preservar (streams SEPARADOS, teto
 * de 15min, cauda por bytes). Os FLAGS de confinamento foram extraídos para
 * `buildSandboxedBashArgs` e são reaproveitados aqui — mesma confinação,
 * outra captura.
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
 *
 * AS TRÊS RECUSAS DURAS (2026-09-21) — e o que NUNCA existe aqui:
 *   1. SEM RAIZ DECLARADA, nada roda (`describeNoDeclaredRoot`): o estado
 *      "executar shell de agente sem um lugar declarado" NÃO EXISTE. Fechado
 *      por decisão do dono, DEPOIS de medir o raio: das 33 tasks sem board
 *      nenhuma é despachável, as 3 não terminais estão dormentes (sem card e
 *      sem vínculo) e task sem board não é mais criável; nenhum board ficou
 *      sem `cwd`. A alternativa era manter um buraco conhecido em EXECUÇÃO
 *      por simetria ("ausência de raiz = ausência de limite"), e essa troca é
 *      a errada quando o custo de fechar é zero;
 *   2. SEM `bubblewrap`, nada roda (`describeSandboxUnavailable`): a recusa é
 *      por comando e o run fica `ok:false`. Não há fallback para execução
 *      direta — é o defeito que este módulo deixou de ter;
 *   3. COM o `cwd` da task FORA da raiz declarada do board, nada roda
 *      (`describeTaskCwdOutsideRootExecution`): o `cwd` decide ONDE, e um
 *      diretório que o board não declarou não é lugar de executar shell de
 *      agente.
 *   Fora isso, o processo do HOST é SEMPRE o binário do sandbox: o comando só
 *   existe como argv de `bash -lc` DENTRO do bwrap, e `GateSpawn` tem
 *   assinatura `(file, args, options)` — não há onde passar uma string de
 *   shell, então reintroduzir `shell: true` no host é impossível por
 *   acidente. `tests/unit/gate-runner-containment.test.ts` trava os quatro.
 *
 *   Toda recusa é POR COMANDO e vira evidência com `exitCode: null` + o
 *   motivo, para a Fila nomear o que deixou de rodar em vez de parecer falha
 *   de teste. A raiz que se aplica a uma task vem de `declaredRootForTask`
 *   (`task-dispatch-decision.ts`): sem board ela é indefinida, e indefinida
 *   aqui significa RECUSA, não permissão.
 */

import { spawn, execFile, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { effectivePath } from "./user-env";
import { buildSandboxedBashArgs, findSandboxBinary } from "./sandbox";
import { describeTaskCwdOutsideRootExecution, isPathInsideRoot } from "./task-dispatch-decision";

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

/**
 * POR QUE um comando de gate não é um passe (task 17d96ade). Antes disto TODO
 * não-zero virava `ok:false` — e `bash: rtk: comando não encontrado` (exit
 * 127) era INDISTINGUÍVEL de um teste que falhou, com a mensagem perdida no
 * stdout/stderr truncado. O veredito passa a DIZER qual foi (ver
 * `classifyGateFailure`), e um gate que nunca rodou deixa de parecer um gate
 * que reprovou.
 */
export type GateFailureKind =
  | "ok"
  | "test-failed"
  | "command-not-found"
  | "not-executable"
  | "timeout"
  | "not-run";

export type GateCommandEvidence = {
  command: string;
  /** Quando um wrapper MORTO foi removido (ver `normalizeGateCommand`), o
   * comando que DE FATO rodou. `null` = rodou exatamente `command`. */
  normalizedCommand: string | null;
  /** POR QUE este comando não é passe — o ponto da task 17d96ade. */
  failureKind: GateFailureKind;
  /** Em `command-not-found`: o executável que faltou (1º token do comando que
   * rodou). `null` nos demais — nunca inventado. */
  missingExecutable: string | null;
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
  /**
   * O diff observado pelo app ao fim da rodada (task 7096e8af). DENTRO do
   * lock de propósito: é o instante em que o app olha o repo com autoridade,
   * e é a evidência que o revisor lê em vez da lista que o implementador
   * digitou. Ausente em linha antiga — e isso é normal.
   */
  diff?: DiffCaptureEvidence;
  /**
   * O RÓTULO DA JANELA no nível do RUN (task c73fcd79): diz que este snapshot
   * foi capturado na ÁRVORE COMPARTILHADA e — quando há mudança fora do
   * território declarado — que o resultado PODE ser de outro card. Mesmo dado
   * do `diff`, no lugar onde a conclusão é tirada. Ausente em linha antiga.
   */
  window?: GateRunWindowLabel;
};

/** Spawn SEM shell no host: o comando de um gate só vira argv de
 * `bash -lc` DENTRO do bwrap (ver `sandbox.ts`). A assinatura é
 * `(file, args, options)` — e não uma string de shell — para que
 * reintroduzir `shell: true` no host seja impossível por acidente: não há
 * onde passar a string crua. */
export type GateSpawn = (file: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;

export type RunTaskGatesInput = {
  taskId: string;
  cwd: string;
  gates: string[];
  timeoutMs?: number;
  /** Seam de teste — a produção passa o `spawn` real. */
  spawnFn?: GateSpawn;
  /** Seam de teste — a produção usa `effectivePath()`. */
  pathValue?: string;
  /** Seam de teste — a produção resolve com `findSandboxBinary()`.
   * `null` força a recusa; um caminho força aquele binário. */
  sandboxBinary?: string | null;
  /** RAIZ DECLARADA do board (`boards.cwd`) — o gate NÃO roda se o `cwd` da
   * task estiver fora dela (2026-09-21). Ausente/`""` = sem limite declarado:
   * não se inventa recusa. Consumidor irmão: o auto-dispatch do bus. */
  declaredRoot?: string | null;
  /** TERRITÓRIO DECLARADO da task, só para ROTULAR o diff capturado
   * (dentro/fora). Nunca filtra: medido, 75,5% dos arquivos declarados caem
   * fora, e o desvio é justamente o que interessa. */
  territory?: readonly string[] | null;
  /** Seam de teste da captura do diff — a produção usa o `git` do host. */
  gitFn?: GitCaptureFn;
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

/** AGENT-FACING — DO NOT TRANSLATE. Recusa visível quando não há bubblewrap:
 * gates são shell de autoria de agente e NÃO rodam sem confinamento. */
export function describeSandboxUnavailable(): string {
  return (
    "[de: stellar] gate NOT run: sandbox (bubblewrap/bwrap) is unavailable on this system. " +
    "A task's gates are agent-authored shell and do not run without confinement — " +
    "install bubblewrap. Nothing was executed."
  );
}

/** AGENT-FACING — DO NOT TRANSLATE. Recusa quando a task não tem raiz
 * declarada (sem board, ou board sem `cwd`). Serve os DOIS consumidores de
 * `cwd` — o gate (execução de shell) e o auto-dispatch (abertura de card) —
 * com o MESMO texto de causa, porque é a MESMA pergunta: onde esta task pode
 * rodar? Duas redações seriam duas noções outra vez. */
export function describeNoDeclaredRoot(where: "gate" | "auto-dispatch" = "gate"): string {
  return (
    `[de: stellar] ${where} NOT run: the task has no declared root (no board, or a board without cwd). ` +
    "Without a declared root there is no authorised place for the app to act on behalf of an agent — " +
    "link the task to a board with a declared cwd. Nothing was executed."
  );
}

/** Evidência de um gate que NÃO foi executado. `exitCode: null` +
 * `failureKind: "not-run"` + o motivo em `stderr` mantém o contrato "nunca
 * mentir sobre o que foi medido": o run inteiro fica `ok:false` e quem lê a
 * evidência vê que não houve execução, em vez de um vermelho que parece teste
 * falhado. */
function refusalEvidence(command: string, reason: string): GateCommandEvidence {
  return {
    command,
    normalizedCommand: null,
    failureKind: "not-run",
    missingExecutable: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    startedAt: Date.now(),
    durationMs: 0,
    stdout: "",
    stderr: reason,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(reason, "utf8"),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

/**
 * Classifica POR QUE o comando não é um passe (task 17d96ade). Pura: só olha
 * o que o processo devolveu. `127` é o "command not found" do `bash -lc` que
 * envolve TODO gate — NUNCA é lido como "o teste falhou" (e também nunca como
 * verde: o run segue `ok:false`; o que muda é o veredito DIZER qual foi).
 */
export function classifyGateFailure(input: {
  exitCode: number | null;
  timedOut: boolean;
  /** true quando o comando sequer foi tentado (recusa por sandbox/raiz/cwd). */
  notRun?: boolean;
}): GateFailureKind {
  if (input.notRun) return "not-run";
  if (input.timedOut) return "timeout";
  if (input.exitCode === null) return "not-run";
  if (input.exitCode === 0) return "ok";
  if (input.exitCode === 127) return "command-not-found";
  if (input.exitCode === 126) return "not-executable";
  return "test-failed";
}

/** O 1º executável do PRIMEIRO comando de um encadeamento shell — pulando
 * `env` e atribuições `VAR=x` (`NODE_ENV=test npm test` → `npm`). `null`
 * quando não há token. É o que permite NOMEAR o comando ausente. */
export function extractExecutable(command: string): string | null {
  const first = (command.split(/&&|\|\||;|\|/)[0] ?? "").trim();
  const tokens = first.split(/\s+/).filter(Boolean);
  let i = 0;
  if (tokens[i] === "env") {
    i += 1;
    while (tokens[i]?.includes("=")) i += 1;
  }
  while (tokens[i] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] as string)) i += 1;
  return tokens[i] ?? null;
}

/**
 * Diretórios de `PATH` VISÍVEIS dentro do gate. O `buildSandboxedBashArgs`
 * faz `--ro-bind / /` + `--tmpfs $HOME` + `--bind <root> <root>`: tudo sob
 * `$HOME` que não esteja sob a RAIZ re-bindada é OCULTADO por um tmpfs vazio.
 * Logo um binário em `~/.local/bin` RESOLVE no host e NÃO RESOLVE no gate —
 * medido (task 17d96ade): `rtk` (v0.43.0, `~/.local/bin/rtk`) → 127 dentro do
 * sandbox. É esta a diferença entre "instalado" e "alcançável pelo gate".
 */
export function gateVisiblePathDirs(pathValue: string, home: string, root: string): string[] {
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const within = (child: string, parent: string) =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  return pathValue
    .split(delimiter)
    .filter((dir) => dir.trim().length > 0)
    .filter((dir) => {
      const abs = resolve(dir);
      if (!within(abs, home)) return true; // fora de $HOME: visível
      return within(abs, root); // sob $HOME: só se a raiz re-bindada o cobre
    });
}

/** Seam de I/O: `<caminho>` é arquivo executável? */
export type ExecutableProbe = (candidate: string) => boolean;

export function isExecutableReachable(
  name: string | null,
  dirs: readonly string[],
  probe: ExecutableProbe,
): boolean {
  if (!name) return false;
  if (name.includes("/")) return probe(name);
  return dirs.some((dir) => probe(join(dir, name)));
}

/** Wrappers que um gate declara e cujo binário o sandbox NÃO alcança. `rtk`
 * (`rtk proxy <cmd>`), quando instalado, vive em `~/.local/bin` — oculto pelo
 * `--tmpfs $HOME`. Medido no board 64: 83 tasks declaram `rtk proxy npx tsc
 * --noEmit` e ele sai SEMPRE 127; o wrapper é MORTO para o gate. */
export const DEAD_GATE_WRAPPERS = ["rtk"] as const;

/**
 * Remove um wrapper MORTO do comando declarado — o `rtk proxy <cmd>` vira
 * `<cmd>` quando `rtk` não é alcançável DENTRO do gate. Não é "consertar a
 * declaração do usuário": é rodar a intenção dela (o comando de baixo) quando
 * o wrapper não pode existir no confinamento. Se o wrapper FOR alcançável, a
 * declaração é respeitada ao pé da letra. Pura: a alcançabilidade entra como
 * parâmetro.
 */
export function normalizeGateCommand(
  command: string,
  reachable: (name: string) => boolean,
): { command: string; stripped: string | null } {
  for (const wrapper of DEAD_GATE_WRAPPERS) {
    // `String.match`, não `RegExp.exec`: o teste de confinamento do módulo
    // proíbe a FORMA `exec(` na fonte (guarda anti-`child_process.exec`), e a
    // regex é a mesma — só não reintroduz o padrão que denuncia shell do host.
    const match = command.match(new RegExp(`^\\s*${wrapper}\\s+proxy\\s+(.+)$`, "s"));
    if (!match) continue;
    if (reachable(wrapper)) return { command, stripped: null };
    return { command: match[1]!.trim(), stripped: wrapper };
  }
  return { command, stripped: null };
}

function defaultExecutableProbe(candidate: string): boolean {
  try {
    const s = statSync(candidate);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export type DiffFileEntry = {
  path: string;
  /** Código do `git status --porcelain` (M, A, D, ??, R...). */
  status: string;
  /** Está dentro do TERRITÓRIO DECLARADO da task? */
  inTerritory: boolean;
  /** `false` quando a task não declarou território — aí não há rótulo a dar,
   * e isso é dito em vez de chutado. */
  territoryDeclared: boolean;
};

/**
 * O DIFF ANEXADO À TASK — uma OBSERVAÇÃO do app, ao lado do que a task
 * DECLAROU, nunca no lugar disso.
 *
 * ---------- POR QUE ISTO NÃO VIOLA O CONTRATO (task 7096e8af) ----------
 * `task-contract-decision.ts` diz, no cabeçalho: "Absence of every field is
 * NORMAL. Never invent territory by watching the filesystem, never intercept
 * `git add`, never judge gate output." A proibição é sobre o app FABRICAR A
 * DECLARAÇÃO a partir da observação, e este campo vai na direção oposta:
 *
 *   1. `territory` continua DECLARADO pelo humano/agente. O diff NUNCA o
 *      realimenta — derivar território do que o agente tocou seria
 *      literalmente "invent territory by watching the filesystem", e é a
 *      "melhoria" futura que este comentário existe para impedir;
 *   2. o diff é campo SEPARADO e ROTULADO (evidência de MUDANÇA), e não
 *      substitui nem preenche campo nenhum do contrato;
 *   3. é leitura PÓS-HOC: sem hook de git, sem `git add`, sem ler o índice —
 *      e este runner nunca escreve no repo.
 *
 * É a MESMA classe de coisa que já está aqui: o app já carimba stdout/stderr/
 * exit code REAIS do gate. Anexar o diff é mais observação, não julgamento —
 * e `ok` continua sendo o exit code, nunca um parse de saída.
 *
 * MEDIDO (no banco real, 2026-09-20) — por que o território aqui é RÓTULO e
 * nunca FILTRO: 75,5% dos arquivos declarados em `filesChanged` caem FORA do
 * território declarado (142 de 188, com 46 de 65 relatórios tendo pelo menos
 * um fora). Filtrar pelo território apagaria justamente o desvio, que é o
 * motivo número um de alguém querer ver o diff.
 */
export type DiffCaptureEvidence = {
  gitRoot: string | null;
  /** `--stat` sempre (pequeno e limitado), quando há repo. */
  stat: string;
  /** Corpo do diff, só de arquivos TRACKED. Untracked não tem patch. */
  patch: string;
  /** `true` quando o corpo bateu no teto — um diff truncado que não diz que
   * foi truncado é mentira. */
  patchTruncated: boolean;
  /** Os caminhos que mudaram nesta janela, untracked incluídos.
   *
   * "TODOS" é o que se quer dizer — e por isso o truncamento vem DECLARADO ao
   * lado (`filesTruncated`) em vez de ficar implícito: a lista passa pelo mesmo
   * teto de captura do patch, e uma promessa de completude que não se pode
   * cumprir é a mesma mentira que um patch cortado sem marca (task 56604aca,
   * decisão do dono: o teto do patch nunca foi alcançado até ser, e a lista não
   * vai esperar o mesmo acontecer com ela).
   *
   * MEDIDO no dado real: a maior lista observada tem 48 caminhos (~3 KB) contra
   * 16 KB de teto — folga de 5x. "Hoje não chega perto" não é garantia; quem lê
   * `total`/`outsideTerritory` para AFIRMAR "N arquivos mudaram" precisa olhar
   * este campo antes. */
  files: DiffFileEntry[];
  /** `true` quando a LISTA de caminhos bateu no teto (os últimos em ordem
   * alfabética teriam sido descartados). Nunca inferido de `total`: o campo
   * diz, e quem exibe conta com ele. */
  filesTruncated: boolean;
  total: number;
  outsideTerritory: number;
  /** `true` quando a task DECLAROU território. Sem ele não há rótulo
   * dentro/fora a dar — e o nível do RUN precisa do mesmo dado (c73fcd79). */
  territoryDeclared: boolean;
  /**
   * O QUE O APP NÃO SABE, dentro do dado e não em nota de rodapé. A árvore é
   * COMPARTILHADA (cinco cards escrevem no mesmo checkout): o app observa
   * MUDANÇA, nunca AUTORIA. Qualquer leitura de "fulano tocou X" é mentira.
   */
  note: string;
};

/** Seam de teste da captura: recebe argv do git e devolve stdout cru. */
export type GitCaptureFn = (
  args: string[],
  cwd: string,
) => Promise<{ ok: boolean; stdout: string; truncated: boolean }>;

function defaultGitCapture(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; truncated: boolean }> {
  return new Promise((done) => {
    const child = spawn("git", args, { cwd });
    // CABEÇA, não cauda (task 56604aca): a saída do git aqui é uma listagem em
    // ordem ALFABÉTICA (`diff`, `diff --stat`, `status --porcelain`), e a parte
    // informativa é o começo. MEDIDO com a cauda: dos 48 arquivos sujos de uma
    // árvore real, o patch capturado guardava 2 a 6 — e ZERO de `src/main` em
    // 29 patches, porque o teto ficava com `tests/*`. O teto não estava só
    // cortando: estava cortando exatamente os arquivos que alguém quer separar.
    const out = new HeadCollector(MAX_CAPTURE_BYTES);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.on("error", () => done({ ok: false, stdout: "", truncated: false }));
    // `truncated` mora no COLETOR (`seen > max`): a mesma marca do gate, com a
    // mesma constante — nenhuma disciplina paralela para divergir.
    child.on("close", (code: number | null) =>
      done({ ok: code === 0, stdout: out.toString(), truncated: out.truncated }),
    );
  });
}

/** Rótulo de território para um caminho. Aceita as duas formas que o dado
 * real tem: caminho puro, e entrada com prosa no fim (`src/main (Fila)`) —
 * medido: 43 das 366 entradas do banco não são caminho puro. */
export function isInsideTerritory(file: string, territory: readonly string[]): boolean {
  const f = file.replace(/^\.\//, "");
  for (const raw of territory) {
    const entry = raw.replace(/\s*\(.*\)\s*$/, "").replace(/\/+$/, "").trim();
    if (!entry) continue;
    if (f === entry) return true;
    if (f.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/** A frase que um revisor APRESSADO não pode confundir com autoria. */
export function describeDiffAuthorship(total: number, outside: number, territoryDeclared: boolean): string {
  const onde = territoryDeclared
    ? `${outside} deles fora do território declarado`
    : "a task não declarou território, então não há como rotular dentro/fora";
  return (
    `Estes arquivos mudaram nesta janela do repositório, ${total} no total — ${onde}. ` +
    `A árvore é compartilhada: o app observa MUDANÇA, não AUTORIA, e não sabe dizer quais destas ` +
    `mudanças vieram desta task e quais vieram de outro card.`
  );
}

/**
 * O RÓTULO DA JANELA, no NÍVEL DO RUN (task c73fcd79).
 *
 * O diff já era rotulado (7096e8af), mas o rótulo morava DENTRO de `diff`.
 * Quem lê `ok:false` / `tsc exit 2` lê o VEREDITO, não a lista de arquivos — e
 * foi assim que dois reviewers de hoje leram o vermelho do vizinho como se
 * fosse da entrega (o erro era de um `message-bus.ts` de outro card, editado em
 * voo na MESMA árvore). O dado não mudou: o MESMO `inTerritory`/`outside`
 * capturado subiu para o nível em que a conclusão é tirada, e diz o que a
 * leitura sozinha não diz — a janela é COMPARTILHADA, e o vermelho PODE não ser
 * desta task.
 *
 * O que isto NÃO é (e é o que `task-contract-decision.ts` proíbe): não é
 * autoria (o app observa MUDANÇA, nunca diz quem tocou); não julga a saída do
 * gate (o veredito continua sendo o exit code — nenhum parse); não olha o FS
 * de novo nem intercepta índice. É observação PÓS-HOC do dado JÁ capturado,
 * com o rótulo no lugar onde a conclusão se forma.
 */
export type GateRunWindowLabel = {
  /** `true` quando a task declarou território — sem isso não há dentro/fora. */
  territoryDeclared: boolean;
  total: number;
  outsideTerritory: number;
  /** `true` quando a janela traz mudança que a task NÃO declarou: o snapshot
   * não pode ser lido como "só o meu trabalho estava aqui". */
  mayIncludeOtherTasksWork: boolean;
  note: string;
};

/** A frase do run. NUNCA afirma autoria; no caso LIMPO não liga alarme (um
 * rótulo que grita sempre vira ruído e ninguém lê). */
export function describeWindowProvenance(input: {
  ok: boolean;
  total: number;
  outsideTerritory: number;
  territoryDeclared: boolean;
  gitRoot: string | null;
}): string {
  if (!input.gitRoot) return "o cwd desta task não é um repositório git — não há janela a rotular.";
  const onde = input.territoryDeclared
    ? `${input.outsideTerritory} de ${input.total} mudança(s) FORA do território declarado desta task`
    : "a task não declarou território, então não há como dizer quais destas mudanças são dela";
  const base =
    `Snapshot da ÁRVORE COMPARTILHADA: ${input.total} arquivo(s) mudaram nesta janela, ${onde}. ` +
    `O app observa MUDANÇA, nunca AUTORIA.`;
  // Caso LIMPO: nada a acrescentar — e o silêncio aqui é deliberado.
  if (input.ok || input.outsideTerritory === 0) return base;
  return (
    `${base} O gate saiu VERMELHO e havia mudança FORA do território declarado desta task: ` +
    `o vermelho PODE vir de outro card, que escreve no MESMO checkout — o app não pode dizer QUEM o ` +
    `causou. Não leia este snapshot como "o erro é desta entrega" sem reconferir a árvore.`
  );
}

/** Deriva o rótulo do run a partir do diff JÁ capturado (nenhuma observação
 * nova). `mayIncludeOtherTasksWork` olha a janela, não o veredito: um snapshot
 * com trabalho alheio é misto mesmo quando passa. */
export function labelGateWindow(diff: DiffCaptureEvidence, ok: boolean): GateRunWindowLabel {
  return {
    territoryDeclared: diff.territoryDeclared,
    total: diff.total,
    outsideTerritory: diff.outsideTerritory,
    mayIncludeOtherTasksWork: diff.total > 0 && (!diff.territoryDeclared || diff.outsideTerritory > 0),
    note: describeWindowProvenance({
      ok,
      total: diff.total,
      outsideTerritory: diff.outsideTerritory,
      territoryDeclared: diff.territoryDeclared,
      gitRoot: diff.gitRoot,
    }),
  };
}

/**
 * Extrai `gateRun.diff` de um `result_json` de task (task 7096e8af) — o seam
 * ON-DEMAND que faltava entre a captura (que já está no HEAD) e a Fila.
 *
 * PURO e defensivo: linha antiga, JSON podre, `gateRun` ausente ou sem `diff`
 * => `null`, e a UI simplesmente não desenha o bloco. NÃO julga o conteúdo (o
 * shape é o que `captureDiff` gravou); quem DECIDE o que a tela mostra é
 * `src/renderer/src/task-diff-presentation.ts`. O push do board projeta
 * `result_json` como NULL DE PROPÓSITO (tamanho), então isto é lido SOB
 * DEMANDA — nunca por evento.
 */
export function parseGateDiffEvidence(resultJson: string | null | undefined): DiffCaptureEvidence | null {
  if (!resultJson) return null;
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const gateRun = (parsed as Record<string, unknown>).gateRun;
    if (typeof gateRun !== "object" || gateRun === null) return null;
    const diff = (gateRun as Record<string, unknown>).diff;
    if (typeof diff !== "object" || diff === null) return null;
    return diff as DiffCaptureEvidence;
  } catch {
    return null;
  }
}

export async function captureDiff(opts: {
  gitRoot: string | null;
  territory?: readonly string[] | null;
  gitFn?: GitCaptureFn;
}): Promise<DiffCaptureEvidence> {
  const git = opts.gitFn ?? defaultGitCapture;
  const declared = (opts.territory ?? []).filter((t) => typeof t === "string" && t.trim());
  const territoryDeclared = declared.length > 0;
  if (!opts.gitRoot) {
    return {
      gitRoot: null,
      stat: "",
      patch: "",
      patchTruncated: false,
      // Lista vazia AQUI é completa: não há repositório, logo não há caminho a
      // listar — truncamento seria dizer que se perdeu algo que nunca existiu.
      files: [],
      filesTruncated: false,
      total: 0,
      outsideTerritory: 0,
      territoryDeclared: false,
      note: "o cwd desta task não é um repositório git — não há diff a observar.",
    };
  }

  const status = await git(["status", "--porcelain=v1"], opts.gitRoot);
  const stat = await git(["diff", "--stat"], opts.gitRoot);
  const body = await git(["diff"], opts.gitRoot);

  const files: DiffFileEntry[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.trim() === "") continue;
    // Formato porcelain v1: XY <path>; com rename vem "XY <orig> -> <novo>".
    const code = line.slice(0, 2).trim() || "??";
    const raw = line.slice(3).trim();
    const path = raw.includes(" -> ") ? raw.split(" -> ").pop()!.trim() : raw;
    if (!path) continue;
    files.push({
      path: path.replace(/^"|"$/g, ""),
      status: code,
      inTerritory: territoryDeclared ? isInsideTerritory(path, declared) : false,
      territoryDeclared,
    });
  }
  const outside = files.filter((f) => territoryDeclared && !f.inTerritory).length;
  return {
    gitRoot: opts.gitRoot,
    stat: stat.stdout.slice(0, MAX_CAPTURE_BYTES),
    patch: body.stdout,
    patchTruncated: body.truncated,
    files,
    filesTruncated: status.truncated,
    total: files.length,
    outsideTerritory: outside,
    territoryDeclared,
    note: describeDiffAuthorship(files.length, outside, territoryDeclared),
  };
}

async function execute(input: RunTaskGatesInput): Promise<GateRunEvidence> {
  const requestedCwd = resolve(input.cwd);
  const gitRoot = await resolveGitRoot(requestedCwd);
  const spawnCwd = gitRoot ?? requestedCwd;
  const spawnFn = input.spawnFn ?? (spawn as GateSpawn);
  const timeoutMs = input.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const pathValue = input.pathValue ?? effectivePath();
  const env = { ...process.env, PATH: pathValue };
  // Alcançável DENTRO do gate: o `--tmpfs $HOME` do bwrap esconde o que mora
  // sob `$HOME` fora da raiz re-bindada. É por isto que `rtk` (em `~/.local/bin`)
  // sai 127 apesar de instalado — ver `gateVisiblePathDirs` (task 17d96ade).
  const visibleDirs = gateVisiblePathDirs(pathValue, homedir(), spawnCwd);
  const reachable = (name: string) => isExecutableReachable(name, visibleDirs, defaultExecutableProbe);
  // Resolvido UMA vez por run: o binário que confina todos os comandos (o
  // mesmo que a tool `bash` do chat usa). Sem ele, NADA roda — ver abaixo.
  const sandboxBinary = input.sandboxBinary !== undefined ? input.sandboxBinary : findSandboxBinary();

  return withRepoGateLock(lockKeyFor(gitRoot, requestedCwd), async () => {
    // Dentro do lock de propósito: fora dele, `startedAt` seria o instante
    // do PEDIDO e `finishedAt - startedAt` incluiria a espera na fila do
    // repositório — um gate de 4s atrás de outro de 10min pareceria ter
    // durado 10min. Os tempos por comando sempre foram reais.
    const startedAt = Date.now();
    const commands: GateCommandEvidence[] = [];
    // CONFINAMENTO DO `cwd` (2026-09-21) — o gate roda no `cwd` da task, e o
    // `cwd` DECIDE ONDE. Um caminho fora da raiz declarada do board é recusa
    // POR COMANDO, pela mesma razão do sandbox logo abaixo: a evidência diz
    // qual comando deixou de rodar, em vez de rodá-lo em outro lugar.
    const declaredRoot =
      typeof input.declaredRoot === "string" && input.declaredRoot.trim().length > 0 ? input.declaredRoot : null;
    if (declaredRoot === null) {
      // SEM RAIZ DECLARADA NÃO SE EXECUTA (decisão do dono, 2026-09-21). Este
      // ramo é o que fecha o resíduo legado: antes, raiz ausente significava
      // "sem limite" e os gates de uma task sem board rodavam mesmo assim.
      const reason = describeNoDeclaredRoot();
      for (const command of input.gates) commands.push(refusalEvidence(command, reason));
    } else if (!isPathInsideRoot(requestedCwd, declaredRoot)) {
      const reason = describeTaskCwdOutsideRootExecution({ where: "gate", cwd: requestedCwd, root: declaredRoot });
      for (const command of input.gates) commands.push(refusalEvidence(command, reason));
    } else if (!sandboxBinary) {
      // Sem bwrap não existe fallback para execução direta: rodar o shell
      // do agente sem confinamento é exatamente o defeito que este caminho
      // deixa de fazer. A recusa é POR COMANDO, para a evidência nomear
      // cada gate que deixou de rodar.
      const reason = describeSandboxUnavailable();
      for (const command of input.gates) commands.push(refusalEvidence(command, reason));
    } else {
      for (const command of input.gates) {
        // Um wrapper MORTO (`rtk proxy <cmd>`, cujo binário o sandbox não
        // alcança) é removido para o gate rodar a INTENÇÃO declarada — e a
        // remoção fica registrada em `normalizedCommand`, nunca em silêncio.
        const { command: ranCommand } = normalizeGateCommand(command, reachable);
        commands.push(await runOne(command, ranCommand, { root: spawnCwd, env, timeoutMs, spawnFn, sandboxBinary }));
      }
    }
    // O diff é capturado DEPOIS dos gates e dentro do mesmo lock: é a
    // observação do app sobre o que mudou nesta janela, ao lado do contrato
    // declarado (ver `DiffCaptureEvidence` para o que isto não é).
    const diff = await captureDiff({ gitRoot, territory: input.territory, gitFn: input.gitFn });
    const ok = commands.length > 0 && commands.every((c) => c.exitCode === 0);
    return {
      taskId: input.taskId,
      requestedCwd,
      gitRoot,
      startedAt,
      finishedAt: Date.now(),
      ok,
      commands,
      diff,
      // O rótulo do veredito, ao lado do veredito (c73fcd79).
      window: labelGateWindow(diff, ok),
    };
  });
}

function runOne(
  declaredCommand: string,
  ranCommand: string,
  opts: { root: string; env: NodeJS.ProcessEnv; timeoutMs: number; spawnFn: GateSpawn; sandboxBinary: string },
): Promise<GateCommandEvidence> {
  return new Promise((done) => {
    const startedAt = Date.now();
    const out = new TailCollector(MAX_CAPTURE_BYTES);
    const err = new TailCollector(MAX_CAPTURE_BYTES);
    let timedOut = false;
    let settled = false;

    // O comando entra como argv de `bash -lc` DENTRO do bwrap; no host não
    // existe shell nenhum (`shell: true` foi removido de propósito). São os
    // MESMOS flags que a tool `bash` do chat usa, vindos de `sandbox.ts`.
    const args = buildSandboxedBashArgs(opts.root, ranCommand);
    const child = opts.spawnFn(opts.sandboxBinary, args, {
      cwd: opts.root,
      env: opts.env,
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
      const failureKind = classifyGateFailure({ exitCode, timedOut });
      done({
        command: declaredCommand,
        normalizedCommand: ranCommand === declaredCommand ? null : ranCommand,
        failureKind,
        // NOMEIA o ausente — o ponto da task 17d96ade: um `bash: X: command
        // not found` deixa de ser um `ok:false` mudo.
        missingExecutable: failureKind === "command-not-found" ? extractExecutable(ranCommand) : null,
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

/**
 * Coletor de CABEÇA — o espelho do `TailCollector`, e a escolha entre os dois
 * é do DADO, não de gosto (task 56604aca):
 *
 *   - SAÍDA DE GATE (stdout/stderr de teste): a parte informativa é o FIM — o
 *     resumo, o erro fatal, o "3 failed". `TailCollector`, e continua.
 *   - SAÍDA DE GIT: é uma listagem em ordem alfabética, e a parte informativa é
 *     o COMEÇO (cabeçalho de arquivo, cabeçalho de hunk, o caminho). Com a
 *     cauda, `src/main/*` — os arquivos que a atribuição precisa separar —
 *     nunca entrava no patch. Ver a medição em `defaultGitCapture`.
 *
 * O corte pode partir um caractere multibyte na borda (um U+FFFD no fim do
 * texto retido) — propriedade que o `TailCollector` já tinha na borda oposta,
 * herdada do mesmo desenho: corta-se por byte, e o dado diz que truncou.
 */
export class HeadCollector {
  private chunks: Buffer[] = [];
  private kept = 0;
  seen = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.seen += chunk.length;
    if (this.kept >= this.max) return; // cheio: só conta, não guarda
    const room = this.max - this.kept;
    const keptChunk = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.chunks.push(keptChunk);
    this.kept += keptChunk.length;
  }

  get truncated(): boolean {
    return this.seen > this.max;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Buffer de cauda limitado por bytes: guarda os ÚLTIMOS `max` bytes e conta o
 * total visto, para a truncagem ser declarada, não muda. É o coletor do
 * STDOUT/STDERR DE GATE (a parte informativa de um teste é o fim). Saída de git
 * usa o `HeadCollector` — ver a medição lá em cima. */
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
