import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { which } from "./providers";

/**
 * PATH efetivo do usuário — o ambiente que o Stellar precisa ver para
 * achar as CLIs de agente e para dar a todo PTY um shell utilizável.
 *
 * O problema que este módulo existe para resolver (relatado ao vivo,
 * 2026-09-08 — "o sistema de path atual tanto para detectar as
 * instalações do cli e para verificação é ineficiente em sistemas como
 * mac"): um `.app` Electron aberto pelo Finder/Dock/Spotlight/`open -a`
 * no macOS NÃO herda o ambiente da login shell. Ele herda o do launchd,
 * que é `PATH=/usr/bin:/bin:/usr/sbin:/sbin` e cwd `/`. Como
 * `providers.ts::which()` sempre foi uma varredura pura de
 * `process.env.PATH`, tudo que não é do sistema fica invisível:
 *
 *   /opt/homebrew/bin            Homebrew em Apple Silicon
 *   /usr/local/bin               Homebrew em Intel
 *   ~/.local/bin                 onde os installers oficiais de `agy` e
 *                                `agent`/`cursor-agent` fazem symlink
 *   ~/.nvm/versions/node/<v>/bin  npm-globals sob nvm — `claude`, `codex`
 *
 * O sintoma é pior que "não acha": `checkAgentAvailability()` reporta
 * "não instalado" para uma CLI que ESTÁ instalada, e o Topbar oferece
 * instalar de novo o que já existe. `npm run dev` a partir de um terminal
 * nunca reproduz nada disso, porque aí o ambiente herdado é o rico — é
 * exatamente por isso que passou tanto tempo sem aparecer.
 *
 * ## Por que não basta uma lista de diretórios
 *
 * Foi a primeira ideia e ela não fecha: com nvm e fnm o caminho carrega a
 * versão ATIVA do Node (`~/.nvm/versions/node/v22.14.0/bin/claude`).
 * Um glob em `~/.nvm/versions/node/*` escolheria uma versão arbitrária —
 * pior que não achar, porque roda a CLI errada em silêncio. Só a shell do
 * usuário sabe qual versão está ativa. `/etc/paths` e
 * `/usr/libexec/path_helper` também não resolvem: cobrem só caminhos de
 * sistema, e a Homebrew deliberadamente não toca `/etc/paths` (o
 * installer dela instrui a pôr `brew shellenv` no `~/.zprofile`).
 *
 * Então a interrogação da login shell é a perna primária e os diretórios
 * conhecidos são a rede de segurança, nunca o contrário.
 *
 * ## Por que a API é síncrona
 *
 * Esta é a decisão de desenho central, e ela vem de um defeito real
 * apontado em review antes de existir código: se a resolução fosse
 * `async` e vazasse para `resolveSpawn()`, ela vazaria para
 * `pty-registry.ts::spawn()`, que registra o PTY no seu mapa `entries`.
 * Com um `await` no meio, um `pty:kill` ou `pty:resize` chegando durante
 * a espera acha `entries.get(id)` vazio e é descartado em silêncio — e
 * quando a promessa resolve, o PTY nasce órfão e com as dimensões
 * erradas. Vazamento de processo em troca de nada.
 *
 * Por isso `effectivePath()` é síncrona e SEMPRE responde: o snapshot
 * nasce no import com o que dá para saber sem spawnar nada, e a perna da
 * shell só o MELHORA depois, em background. Nenhum chamador vira async.
 */

/** Resultado da resolução, só para log e para o smoke de verificação. */
export type UserEnvSource =
  /** PATH da login shell obtido de verdade. */
  | "shell"
  /** Interrogação falhou, foi pulada ou expirou — snapshot inicial. */
  | "inherited";

export type UserEnvSnapshot = { path: string; source: UserEnvSource };

/**
 * Teto de espera pela shell. Curto de propósito: este é um caminho de
 * boot, e o custo de errar para o lado do timeout é só continuar com o
 * snapshot inicial, que já funciona. O caso que justifica o teto existir
 * é um `~/.zprofile` com `exec tmux` (padrão comum de auto-start): o
 * `exec` substitui o shell antes do nosso comando ser avaliado e, com
 * stdin fechado, o tmux nem sobe nem devolve nada.
 */
const SHELL_TIMEOUT_MS = 5_000;

/**
 * Sentinela por invocação. UUID em vez de uma string fixa porque a saída
 * pode vir com qualquer coisa que um dotfile ruidoso imprimiu antes.
 */
function marker(): string {
  return `__stellar_env_${randomUUID().replace(/-/g, "")}__`;
}

/** Um arquivo de verdade e executável — não um diretório com o nome do
 * binário, não um arquivo sem bit de exec. O `existsSync` que estava aqui
 * antes aceitava os dois. */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Diretórios onde as CLIs que o Stellar spawna realmente aterrissam,
 * levantados dos installers oficiais de cada uma (não adivinhados):
 * `agy` e os dois nomes do Cursor fazem symlink em `~/.local/bin`,
 * `opencode` via curl vai para `~/.opencode/bin`, e npm-globals vão para
 * o `bin` do gerenciador de versão ativo. Sem precedência por
 * arquitetura: os dois prefixos de Homebrew entram e a existência do
 * arquivo decide, que é mais honesto que inferir arm64 vs x64.
 *
 * `~/.nvm/versions/node/*` fica fora de propósito — ver o cabeçalho.
 */
export function knownBinDirs(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  if (platform === "win32") return [];
  const dirs = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".npm-global", "bin"),
    join(home, ".local", "share", "fnm", "current", "bin"),
    // Pedidos por nome no depoimento de um usuário de macOS (2026-09-08).
    // Não hospedam nenhuma das CLIs de agente, mas `effectivePath()`
    // também é o PATH de todo PTY do board: sem eles, um agente num card
    // fica sem `cargo`/binário de Go quando a perna da login shell falha.
    join(home, ".cargo", "bin"),
    join(home, "go", "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  // pnpm segue a convenção da Apple no macOS e a XDG no resto.
  dirs.push(platform === "darwin" ? join(home, "Library", "pnpm") : join(home, ".local", "share", "pnpm"));
  return dirs;
}

/** Junta listas de diretórios preservando a ordem da primeira aparição e
 * descartando entradas vazias (um `PATH` com `::` no meio significa "cwd"
 * em algumas shells — não é algo que queremos propagar). */
export function mergePathDirs(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of list) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out;
}

function splitPath(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).filter(Boolean);
}

/**
 * Ordem final do PATH efetivo, e a razão de cada degrau.
 *
 * 1. O que `process.env.PATH` tem e o PATH da shell NÃO tem. Isto é o
 *    override deliberado: quem roda `PATH=/meu/custom:$PATH stellar` de um
 *    terminal quer aquele diretório na frente, e o PATH da login shell
 *    (que não sabe do override) não pode passar na frente dele. Num launch
 *    pelo Finder este degrau é vazio, porque todo diretório do launchd já
 *    aparece no PATH da shell.
 * 2. O PATH da login shell — a ordenação que o usuário realmente escolheu
 *    nos dotfiles dele, incluindo qual versão de Node está ativa.
 * 3. O resto de `process.env.PATH`.
 * 4. Os diretórios conhecidos, como rede.
 */
export function composePath(inheritedPath: string | undefined, shellPath: string | null, binDirs: string[]): string {
  const inherited = splitPath(inheritedPath);
  const shell = splitPath(shellPath ?? undefined);
  const shellSet = new Set(shell);
  const overrides = inherited.filter((dir) => !shellSet.has(dir));
  return mergePathDirs(overrides, shell, inherited, binDirs).join(delimiter);
}

/**
 * Como pedir o PATH para cada família de shell, ou `null` para não pedir.
 *
 * O `script` nunca interpola o caminho do executável: ele chega como
 * parâmetro posicional (`$1`, com `--` ocupando `$0`) e é referenciado
 * entre aspas DUPLAS. Confirmado empiricamente (2026-09-08) que é isto
 * que sobrevive a um caminho com espaço — e no macOS o caminho SEMPRE tem
 * espaço em potencial (`/Applications/Stellar.app/Contents/MacOS/...`).
 * Com `'$1'` entre aspas simples a shell não expande e sai 127; com o
 * caminho concatenado na string do `-c`, ela quebra no espaço.
 *
 * `-l` (login) é o que carrega `~/.zprofile`/`~/.bash_profile`, onde
 * `brew shellenv` e os gerenciadores de versão põem o PATH. `-i`
 * (interativo) carrega também `~/.zshrc`/`~/.bashrc`, onde muita gente
 * põe o PATH na prática — vale o risco porque o timeout cobre o caso
 * patológico. `tcsh`/`csh` ficam de fora: lá `-c` e `-l` não combinam e a
 * invocação falha de vez, então nem tentamos.
 */
export function shellQuery(shellPath: string): { args: (script: string, exe: string) => string[] } | null {
  const shell = basename(shellPath);
  if (shell === "tcsh" || shell === "csh") return null;
  if (shell === "fish") {
    // fish não tem a convenção `-c cmd name args` do POSIX: os argumentos
    // extras chegam em `$argv`, com `$argv[1]` sendo o primeiro de
    // verdade (não há `$0`).
    return { args: (script, exe) => ["-l", "-c", script.replace(/"\$1"/g, '"$argv[1]"'), exe] };
  }
  if (shell === "nu") {
    // nushell não aceita flags aglutinadas nem parâmetros posicionais
    // nesse formato; passa o caminho já embutido, entre aspas simples,
    // que é o literal do nu.
    return { args: (script, exe) => ["-l", "-c", script.replace(/"\$1"/g, `'${exe}'`)] };
  }
  return { args: (script, exe) => ["-ilc", script, "--", exe] };
}

/**
 * O último degrau da cadeia, quando nem o ambiente nem a base de usuário
 * do SO dizem qual é a shell. `/bin/zsh` no macOS porque é o padrão de lá
 * desde o Catalina; `/bin/sh` no resto porque é o único caminho que o
 * POSIX obriga a existir — `/bin/bash`, que era o fallback anterior, não
 * existe em toda distro (Alpine, e imagens mínimas em geral).
 */
export function fallbackShell(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/** A login shell do usuário, sem assumir bash em lugar nenhum. */
export function loginShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL) return env.SHELL;
  try {
    // Lê a base do usuário via getpwuid(), não o ambiente — é o que
    // sobra quando o launchd não passou SHELL nenhum.
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // userInfo() pode lançar em ambiente sem entrada de passwd.
  }
  return fallbackShell(platform);
}

/**
 * Pergunta o PATH para a login shell. Resolve `null` em qualquer falha —
 * este caminho nunca lança e nunca é fatal, porque o snapshot inicial já
 * é utilizável sem ele.
 *
 * Executa o PRÓPRIO binário do Electron como Node
 * (`ELECTRON_RUN_AS_NODE=1`) em vez de chamar `env` ou `node`: `node` é
 * justamente o que pode não estar no PATH (é o mesmo motivo pelo qual o
 * shebang `#!/usr/bin/env node` do `acbridge` morre num launch pelo
 * Finder), e a saída de `env` é ambígua quando alguma variável tem
 * quebra de linha no valor — token, chave SSH, prompt multi-linha. Um
 * `JSON.stringify` do próprio processo não tem essa ambiguidade.
 */
export function queryShellPath(opts: {
  shell?: string;
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  // No Windows o processo já herda o ambiente do usuário — o problema é
  // específico do launchd. Interrogar shell lá seria risco sem ganho.
  if (platform === "win32") return Promise.resolve(null);

  const shell = opts.shell ?? loginShell(platform, opts.env);
  const query = shellQuery(shell);
  if (!query) return Promise.resolve(null);

  const mark = marker();
  const exe = opts.execPath ?? process.execPath;
  const inner = `process.stdout.write(${JSON.stringify(mark)} + JSON.stringify(process.env.PATH ?? "") + ${JSON.stringify(mark)})`;
  const script = `"$1" -e ${JSON.stringify(inner)}`;

  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, query.args(script, exe), {
        // stdin fechado: uma shell que peça algo interativamente falha na
        // hora em vez de travar esperando para sempre. stderr descartado:
        // confirmado ao vivo que `bash -i` sem TTY já escreve avisos de
        // job control ali, e um dotfile ruidoso escreve muito mais — nada
        // disso pode contaminar o que a gente parseia.
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...opts.env ?? process.env,
          ELECTRON_RUN_AS_NODE: "1",
          // Marcador para quem quiser guardar o próprio dotfile contra
          // esta invocação (`[ -n "$STELLAR_RESOLVING_ENV" ] && return`),
          // que é a saída para o caso do `exec tmux` no profile.
          STELLAR_RESOLVING_ENV: "1",
          // Reduz o que zsh/oh-my-zsh fazem de auto-update e auto-tmux
          // durante um rc não interativo de verdade.
          DISABLE_AUTO_UPDATE: "true",
          ZSH_TMUX_AUTOSTART: "false",
          ZSH_TMUX_AUTOSTARTED: "true",
        },
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, opts.timeoutMs ?? SHELL_TIMEOUT_MS);

    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    // `error` e `close` podem ambos disparar (ENOENT dispara os dois) —
    // `finish` é idempotente por isso.
    child.on("error", () => finish(null));
    child.on("close", () => {
      const parts = out.split(mark);
      if (parts.length < 3) return finish(null);
      try {
        const value = JSON.parse(parts[1]) as unknown;
        finish(typeof value === "string" && value.length > 0 ? value : null);
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * Snapshot atual. Nasce no import com o que se sabe sem spawnar nada, de
 * modo que todo chamador síncrono já tem uma resposta utilizável antes de
 * `refreshUserEnv()` sequer começar.
 */
let snapshot: UserEnvSnapshot = {
  path: composePath(process.env.PATH, null, knownBinDirs()),
  source: "inherited",
};

/** O PATH que todo `which`/spawn do app deve usar. Síncrona por desenho
 * — ver o cabeçalho deste arquivo. */
export function effectivePath(): string {
  return snapshot.path;
}

export function userEnvSnapshot(): UserEnvSnapshot {
  return snapshot;
}

let refreshing: Promise<UserEnvSnapshot> | null = null;

/** Uma tentativa por vida do app. Chamada no boot; nunca bloqueia nada. */
export function refreshUserEnv(): Promise<UserEnvSnapshot> {
  if (refreshing) return refreshing;
  refreshing = queryShellPath({}).then(async (shellPath) => {
    if (shellPath) {
      snapshot = { path: composePath(process.env.PATH, shellPath, knownBinDirs()), source: "shell" };
    }
    // Revalida junto do PATH, não antes: `which()` (providers.ts) varre
    // `effectivePath()`, então só faz sentido procurar um `node` real
    // DEPOIS que o snapshot acima já reflete o que a login shell viu —
    // resolver antes correria risco de achar um `node` do PATH mínimo do
    // launchd (se houver) em vez do que o usuário realmente tem.
    realNode = await resolveRealNode();
    return snapshot;
  });
  return refreshing;
}

/**
 * Major mínima de `node` aceitável para os shims de `resources/bin`
 * rodarem — ancorada no que os dois REALMENTE usam, não num número
 * redondo:
 *   - `resources/bin/stellar-mcp:135` — `await fetch(target, ...)`,
 *     `fetch` global sem flag, estável desde o Node 18.
 *   - `resources/bin/acbridge` — `import net from "node:net"` (topo do
 *     arquivo), import ESM estático de builtin com prefixo `node:`,
 *     suportado desde o Node 14 e estável no 18.
 * Nenhum dos dois usa nada que exija major mais alta (sem
 * `structuredClone`, sem `Array.fromAsync`, sem `AbortSignal.timeout`
 * etc. — checado). Se algum dia um dos shims passar a exigir mais,
 * suba este número citando o arquivo:linha que exige, não "22 é
 * moderno".
 */
export const MIN_REAL_NODE_MAJOR = 18;

/**
 * Pura — decide se a SAÍDA já capturada de `node -p
 * "process.versions.node"` (ou equivalente) é um `node` utilizável.
 *
 * A âncora dupla `^...$` contra o output JÁ TRIMADO (não um `.test()`
 * solto, não uma busca do número em qualquer posição) não é só para ler
 * a versão — é a proteção do canal. O stdout do `stellar-mcp` É o
 * transporte JSON-RPC do MCP: um `node` que seja wrapper de verdade
 * (script de `nvm`/`asdf`/`volta`, ou um shim corporativo) e escreva
 * QUALQUER coisa no stdout além do número — aviso antes, aviso depois —
 * tem que ser rejeitado aqui, porque um candidato assim sobe o card sem
 * falar com o board (silencioso, pior que só perder os ~35 MB do
 * fallback). Nenhuma I/O aqui de propósito: é o que o teste exercita
 * para cobrir "aceita 18.x/22.x", "rejeita 16.x", "rejeita saída lixo" e
 * "rejeita ruído antes/depois do número" sem precisar spawnar nada de
 * verdade.
 */
export function isUsableNodeVersion(output: string | null): boolean {
  if (!output) return false;
  const match = /^(\d+)\.\d+\.\d+$/.exec(output.trim());
  if (!match) return false;
  return Number(match[1]) >= MIN_REAL_NODE_MAJOR;
}

/**
 * Roda `<candidate> -p "process.versions.node"` e devolve a saída crua
 * do stdout, ou `null` em qualquer falha (ENOENT, timeout, crash, exit
 * != 0) — mesmo padrão de contenção de `queryShellPath()` (stdio
 * fechado/descartado nas pontas que não interessam, timeout curto,
 * `finish` idempotente porque `error` e `close` podem ambos disparar).
 */
function runNodeVersionCheck(candidate: string, timeoutMs = 2_000): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(candidate, ["-p", "process.versions.node"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);

    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
  });
}

export type RealNodeFinder = (names: string[]) => string | null;
export type RealNodeChecker = (candidate: string) => Promise<string | null>;

/**
 * Resolve um `node` real e VALIDADO, para preferir a `AGENT_CANVAS_NODE`
 * dos PTYs em vez do binário do Electron (ver pty-registry.ts). Achar o
 * caminho não basta: `find` por si só aceitaria um symlink de `nvm`
 * quebrado ou uma major velha, e só a execução real cobre isso —
 * `isExecutableFile` (o default de `which()`) só cobre "existe e tem bit
 * de exec". `find`/`check` são injetáveis para o teste exercitar a
 * decisão real sem depender do que está instalado na máquina do CI.
 * Assíncrona de propósito — nunca é chamada no caminho quente de
 * `pty-registry.ts::spawn()`, só aqui dentro de `refreshUserEnv()`, que
 * já segue o mesmo padrão assíncrono-com-snapshot para o PATH.
 */
export async function resolveRealNode(opts: { find?: RealNodeFinder; check?: RealNodeChecker } = {}): Promise<string | null> {
  const find = opts.find ?? ((names: string[]) => which(names));
  const candidate = find(["node"]);
  if (!candidate) return null;
  const check = opts.check ?? runNodeVersionCheck;
  const output = await check(candidate);
  return isUsableNodeVersion(output) ? candidate : null;
}

/**
 * Snapshot do `node` real, no mesmo padrão de `snapshot`/`effectivePath()`
 * acima: nasce `null` (nada foi validado ainda no import) e só é
 * preenchido por `refreshUserEnv()`, em background.
 *
 * Considerado e descartado (2026-09-09): resolver de forma síncrona-
 * bloqueante (`spawnSync`) na PRIMEIRA chamada de `realNodePath()`, para
 * eliminar a janela em que os primeiros cards caem no fallback. Medido
 * ao vivo nesta máquina, `spawnSync(node, ["-p",
 * "process.versions.node"])` custa **~97-104 ms** (5 execuções, node
 * real do sistema) — isso é MUITO acima de "algumas dezenas de ms", e
 * "bloqueante" aqui quer dizer travar o processo main inteiro (logo a
 * UI do board inteira) exatamente no instante em que o primeiro card é
 * criado, que é o pior momento possível para um freeze perceptível. Não
 * compensa trocar uma inconsistência silenciosa (fallback ocasional, que
 * já é o piso que sempre funciona) por um freeze de board garantido.
 *
 * Consequência assumida, não implícita: um card criado ANTES de
 * `refreshUserEnv()` terminar de resolver e validar o `node` real (que
 * também espera a interrogação da login shell, até `SHELL_TIMEOUT_MS` =
 * 5s) recebe `AGENT_CANVAS_NODE: process.execPath` — o fallback pesado,
 * porém correto. Cards criados depois já pegam o `node` real. Isso é
 * inconsistência de PERFORMANCE entre cards da mesma sessão, nunca de
 * CORREÇÃO — o fallback sempre funciona.
 */
let realNode: string | null = null;

/** O `node` real e validado (major >= {@link MIN_REAL_NODE_MAJOR}), ou
 * `null` se nenhum foi achado/validado ainda — síncrona pelo mesmo
 * motivo de `effectivePath()`: nunca pode virar um `await` no caminho de
 * `pty-registry.ts::spawn()`, e (ver o comentário de `realNode` acima)
 * deliberadamente não virou um `spawnSync` bloqueante no lugar disso.
 * Quem chama trata `null` caindo em `process.execPath`. */
export function realNodePath(): string | null {
  return realNode;
}
