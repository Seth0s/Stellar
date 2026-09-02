import { delimiter } from "node:path";
import * as pty from "node-pty";
import { resolveSpawn, providerInstallCommand, type SpawnOpts } from "./providers";
import { watchForSession } from "./session-watch";

const COALESCE_MS = 16;
const COALESCE_MAX = 64 * 1024;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
// Achado ao vivo (2026-09-02) — chip de URL mostrando "127.0.0.1:5175)":
// saída real de log costuma envolver a URL em parênteses ("(http://…)"),
// e `URL_PATTERN` não para em `)`/`]`/`}` (não dá pra excluir de cara —
// uma URL legítima pode ter parênteses BALANCEADOS dentro, ex. artigos da
// Wikipedia). Corrigido removendo só fechamento(s) no FIM do match que não
// tem abertura correspondente ANTES dele no mesmo match — cobre o caso
// relatado (parêntese só de embrulho, nenhum aberto antes) sem truncar um
// caso balanceado de verdade.
const TRAILING_UNBALANCED_CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
function trimTrailingUnbalancedClosers(url: string): string {
  while (url.length > 0) {
    const last = url[url.length - 1];
    const opener = TRAILING_UNBALANCED_CLOSERS[last];
    if (!opener) break;
    const closers = url.split(last).length - 1;
    const openers = url.split(opener).length - 1;
    if (openers >= closers) break;
    url = url.slice(0, -1);
  }
  return url;
}
// Pre-release audit B5 — bounds how much of a flush's tail gets carried
// forward as a possibly-unterminated URL (see `flush`'s doc comment
// below). Generous for any realistic URL, but never unbounded.
const MAX_URL_CARRY = 2048;
const URL_DELIM_PATTERN = /[\s"'<>]/;
// Pre-release audit B7 — caps `seenUrls` per terminal so a long-running
// agent printing thousands of distinct URLs can't grow it forever.
const MAX_SEEN_URLS = 500;
// Achado ao vivo (2026-09-02) — usuário relatou um `claude` aberto num card
// de terminal ora reabrindo dentro de uma sessão alheia, ora só mostrando
// "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker".
// Causa raiz: quando o próprio Stellar é lançado a partir de um processo
// que é (ou descende de) uma sessão do Claude Code — dev via `npm run dev`
// num terminal do Claude Code, ou o app empacotado aberto de dentro de um
// card de terminal que já roda `claude`, como neste exato processo — essas
// variáveis de identidade de sessão ficam no `process.env` do processo main
// da app inteira. `spawn()` abaixo herdava tudo cegamente; todo card novo
// (claude, codex, bash) passava a herdar a identidade da sessão ALHEIA que
// por acaso lançou o Stellar, nunca uma sessão nova de verdade — inclusive
// `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`, que dariam ao processo novo
// acesso ao canal de IPC de outra sessão. Removidas antes de todo spawn,
// não só pra `claude`: qualquer card aberto no board é sempre um processo
// novo e independente, nunca um filho implícito de quem lançou o app.
function isInheritedClaudeSessionEnvKey(key: string): boolean {
  return key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT" || key === "AI_AGENT" || key.startsWith("CLAUDE_CODE_");
}
// DESIGN-BACKLOG.md item 57, ponto 12 — real bug reported live: seen-url
// chips showed garbage like "claude.ai/cod[54G/a[57Gtifact/..." — raw
// ANSI escapes (cursor repositioning, e.g. terminal line-wrap redraws on
// a long URL) landing INSIDE the matched string, since `URL_PATTERN`'s
// excluded-character class (whitespace/quotes/angle-brackets) never
// excluded control characters. Stripped from a local copy used only for
// URL matching below — never from `data` itself, which still needs its
// real escape codes intact for xterm to render color/cursor movement
// correctly. Same CSI/OSC-stripping pattern as the well-known `ansi-regex`
// npm package (not added as a dependency for one regex) — not
// exhaustive of every obscure escape form, but covers the CSI class
// (cursor movement, colors) actually seen in practice here.
const ANSI_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g",
);

type Entry = {
  proc: pty.IPty;
  cols: number;
  rows: number;
  chunks: string[];
  pending: number;
  flushTimer: NodeJS.Timeout | null;
  stopWatch: (() => void) | null;
  seenUrls: Set<string>;
  /** Pre-release audit B5 — the tail of the last flush's ANSI-stripped
   * text that might still be an in-progress (unterminated) URL, carried
   * into the next flush's match so a URL split right at a flush boundary
   * is still recognized whole. */
  urlCarry: string;
  /** Escalonamento de encerramento (achado ao vivo 2026-09-01) — ver
   * `kill` abaixo. `null` enquanto o processo não foi mandado encerrar. */
  killTimer: NodeJS.Timeout | null;
};

/** Achado ao vivo (2026-09-01): "se eu trocar de sessão os terminais e
 * serviços não são fechados daquela sessão". A causa não era falta de
 * chamada de kill — o unmount do card já chamava — era o `kill` antigo
 * mandar UM `SIGHUP` (o default do node-pty) e apagar a entrada do
 * registry na mesma linha, sem nunca confirmar que o processo morreu. Um
 * CLI que ignora ou demora no SIGHUP virava órfão, e como a entrada já
 * tinha sumido, `isAlive`/`card_status` passavam a mentir "exited" e nada
 * no app sabia mais que aquele processo existia.
 *
 * Um shell (`bash`) propaga SIGHUP e some na hora — por isso o caminho
 * mais testado parecia correto. CLIs de agente são justamente as que
 * instalam handler de sinal pra desligar com calma, então são exatamente
 * as que sobreviviam.
 *
 * A escada dá a chance de saída limpa e ainda assim garante o fim: só o
 * `onExit` REAL do processo remove a entrada. */
const KILL_ESCALATION: NodeJS.Signals[] = ["SIGHUP", "SIGTERM", "SIGKILL"];
const KILL_GRACE_MS = 2_000;

export function createPtyRegistry(registryOpts: {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
  onSessionFound: (id: string, sessionId: string) => void;
  onUrlSeen: (id: string, url: string) => void;
  /** Path to the acbridge Unix socket, and the dir it lives in — injected into every spawned provider's env/PATH. */
  sockPath: string;
  binDir: string;
  /** DESIGN-BACKLOG.md item 21, ponto 9 — the MCP server's own base URL
   * (mcp-server.ts), threaded into `SpawnOpts.mcpUrl` for every spawn so
   * `providers.ts::buildArgs` can register it per-provider. */
  mcpUrl: string;
}) {
  const entries = new Map<string, Entry>();

  /** Pre-release audit B5 — URL sighting used to run on each raw `onData`
   * chunk from node-pty, not on this coalesced buffer. A URL longer than
   * one chunk (a real, reported bug: `pty.onData` splits on arbitrary
   * byte boundaries, not on any text-shaped boundary) was silently
   * missed or emitted truncated. Matching here instead — the same joined
   * text this function already emits to the renderer — fixes chunk
   * splits; `urlCarry` below additionally covers a split at the (rarer)
   * flush boundary itself. */
  function flush(id: string) {
    const e = entries.get(id);
    if (!e || e.chunks.length === 0) return;
    const data = e.chunks.join("");
    e.chunks = [];
    e.pending = 0;
    if (e.flushTimer) {
      clearTimeout(e.flushTimer);
      e.flushTimer = null;
    }
    registryOpts.onData(id, data);

    // Passive URL sighting — the only discoverability path for providers
    // with no system-prompt hook (codex/cursor): never opens anything on
    // its own, just surfaces what the agent already printed as a chip a
    // human can click.
    const cleaned = e.urlCarry + data.replace(ANSI_PATTERN, "");
    for (const rawUrl of cleaned.match(URL_PATTERN) ?? []) {
      const url = trimTrailingUnbalancedClosers(rawUrl);
      if (!e.seenUrls.has(url)) {
        e.seenUrls.add(url);
        registryOpts.onUrlSeen(id, url);
        // Oldest-first eviction — `Set` iterates in insertion order, so
        // its first value really is the oldest sighting.
        if (e.seenUrls.size > MAX_SEEN_URLS) {
          const oldest = e.seenUrls.values().next().value;
          if (oldest !== undefined) e.seenUrls.delete(oldest);
        }
      }
    }
    let lastDelimIdx = -1;
    for (let i = cleaned.length - 1; i >= 0; i--) {
      if (URL_DELIM_PATTERN.test(cleaned[i])) {
        lastDelimIdx = i;
        break;
      }
    }
    e.urlCarry = cleaned.slice(lastDelimIdx + 1).slice(-MAX_URL_CARRY);
  }

  // `id` is the caller's own card id, not a fresh one generated here — the
  // renderer's card id and the PTY's id used to be two separate id spaces
  // (this registry minted its own randomUUID), which meant nothing that
  // deals in "cards" (the message bus's list/send, a browser card's
  // ownerCardId) could actually address a running PTY. Unifying them makes
  // AGENT_CANVAS_CARD_ID, acbridge's targets, and store.listCards() all
  // speak the same id.
  function spawn(
    id: string,
    providerId: string,
    cwd: string,
    cols: number,
    rows: number,
    spawnOpts: SpawnOpts = {},
  ):
    | { id: string }
    | { error: "binary_not_found"; providerId: string; installCommand: string | null }
    | { error: "spawn_failed"; providerId: string } {
    // Carimba a identidade do card na URL do MCP registrada PRA ESTE
    // processo — ver o doc de `buildServer` em mcp-server.ts: sem isso o
    // servidor MCP (um só, compartilhado por todos os cards) dependia do
    // modelo lembrar de preencher `callerCardId`, e quando ele não
    // lembrava o modo autônomo do board simplesmente não valia. Mesmo id
    // do `AGENT_CANVAS_CARD_ID` logo abaixo, mesma fonte.
    const cardMcpUrl = registryOpts.mcpUrl ? `${registryOpts.mcpUrl}?card=${encodeURIComponent(id)}` : registryOpts.mcpUrl;
    const resolved = resolveSpawn(providerId, { ...spawnOpts, mcpUrl: cardMcpUrl });
    if (!resolved) return { error: "binary_not_found", providerId, installCommand: providerInstallCommand(providerId) };

    const inheritedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || isInheritedClaudeSessionEnvKey(key)) continue;
      inheritedEnv[key] = value;
    }

    const env: Record<string, string> = {
      ...inheritedEnv,
      AGENT_CANVAS_SOCK: registryOpts.sockPath,
      AGENT_CANVAS_CARD_ID: id,
      // DESIGN-BACKLOG.md item 21, ponto 9, achado 1 — fork-bomb guard.
      // `spawnOpts.spawnDepth` is only ever set for an agent-initiated
      // spawn (main/index.ts's onSpawnAgentRequest handler); every human-
      // triggered spawn (rail, radial menu) leaves it undefined, starting
      // a fresh chain at depth 0. This process reports its OWN depth back
      // out via acbridge/MCP if IT spawns another agent.
      AGENT_CANVAS_SPAWN_DEPTH: String(spawnOpts.spawnDepth ?? 0),
      // Achado ao vivo (2026-09-01) — o shim `stellar-mcp` (resources/bin)
      // lê isto pra saber a porta VIVA do servidor MCP desta execução da
      // app, já que a porta é efêmera e o registro nas CLIs que não têm
      // flag por invocação (cursor, antigravity) é um arquivo escrito uma
      // vez só. Junto com AGENT_CANVAS_CARD_ID acima, é o par que dá ao
      // shim endereço e identidade sem nada disso estar no arquivo.
      // Sem `?card=` aqui: quem carimba a identidade é o shim, e o
      // `cardMcpUrl` logo acima (que já vai carimbado) é outra coisa — a
      // flag efêmera do claude/codex.
      AGENT_CANVAS_MCP_URL: registryOpts.mcpUrl,
      PATH: `${registryOpts.binDir}${delimiter}${process.env.PATH ?? ""}`,
    };

    let proc: pty.IPty;
    try {
      proc = pty.spawn(resolved.binary, resolved.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      });
    } catch {
      return { error: "spawn_failed", providerId };
    }

    const entry: Entry = {
      proc,
      cols,
      rows,
      chunks: [],
      pending: 0,
      flushTimer: null,
      stopWatch: null,
      seenUrls: new Set(),
      urlCarry: "",
      killTimer: null,
    };
    entries.set(id, entry);

    // Only watch for a fresh session when the caller didn't already pass a
    // resumeId — a spawn that already targets a known session has nothing
    // to discover.
    if (!spawnOpts.resumeId) {
      entry.stopWatch = watchForSession(providerId, cwd, Date.now(), (sessionId) => {
        entry.stopWatch = null;
        registryOpts.onSessionFound(id, sessionId);
      });
    }

    proc.onData((data) => {
      entry.chunks.push(data);
      entry.pending += data.length;
      if (entry.pending >= COALESCE_MAX) {
        flush(id);
        return;
      }
      if (!entry.flushTimer) {
        entry.flushTimer = setTimeout(() => flush(id), COALESCE_MS);
      }
    });

    proc.onExit(({ exitCode }) => {
      flush(id);
      entry.stopWatch?.();
      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.killTimer = null;
      // O ÚNICO lugar que remove uma entrada. `kill` abaixo não remove
      // mais por conta própria: enquanto o processo não sai de verdade,
      // ele continua no registry e `isAlive` continua dizendo a verdade.
      entries.delete(id);
      registryOpts.onExit(id, exitCode);
    });

    return { id };
  }

  function write(id: string, data: string) {
    entries.get(id)?.proc.write(data);
  }

  function resize(id: string, cols: number, rows: number) {
    const e = entries.get(id);
    if (!e || (e.cols === cols && e.rows === rows)) return;
    e.cols = cols;
    e.rows = rows;
    e.proc.resize(cols, rows);
  }

  function interrupt(id: string) {
    entries.get(id)?.proc.write("\x03");
  }

  /** Encerra escalando pela `KILL_ESCALATION` — ver o doc daquela
   * constante. Idempotente: chamar de novo enquanto uma escada já está em
   * curso não reinicia nada (o unmount do card e um `killAll` podem
   * perfeitamente coincidir).
   *
   * `immediate` pula direto pro SIGKILL, pro caminho de fechamento do app:
   * ali não existe os ~4s da escada pra gastar, e um processo que
   * sobrevive ao fim do processo pai é exatamente o órfão que isso tudo
   * existe pra impedir. */
  function kill(id: string, { immediate = false }: { immediate?: boolean } = {}) {
    const e = entries.get(id);
    if (!e) return;
    e.stopWatch?.();
    if (e.killTimer) return;
    if (immediate) {
      try {
        e.proc.kill("SIGKILL");
      } catch {
        // Já morreu entre o get e o kill — nada a fazer.
      }
      entries.delete(id);
      return;
    }
    step(0);

    function step(i: number) {
      // A entrada só some no `onExit` real, então continuar aqui significa
      // que o processo genuinamente ainda está de pé.
      if (!entries.has(id)) return;
      try {
        e!.proc.kill(KILL_ESCALATION[i]);
      } catch {
        // O processo pode ter saído entre o timer e este envio; o onExit
        // real limpa o resto.
        return;
      }
      if (i + 1 >= KILL_ESCALATION.length) {
        // Depois do SIGKILL não há pra onde escalar. Não força
        // `entries.delete` aqui de propósito: o `onExit` do node-pty
        // ainda vai disparar e é ele quem mantém uma fonte de verdade só.
        e!.killTimer = null;
        return;
      }
      e!.killTimer = setTimeout(() => {
        e!.killTimer = null;
        step(i + 1);
      }, KILL_GRACE_MS);
    }
  }

  /** Fechamento do app — SIGKILL direto em tudo, ver `immediate` acima. */
  function killAll() {
    for (const id of [...entries.keys()]) kill(id, { immediate: true });
  }

  /** Whether a PTY is actually running right now — the remote-control
   * mobile mirror (remote-server.ts) uses this instead of duplicating the
   * renderer's own liveStatus tracking (spawnError/exitCode), since "has a
   * live entry here" is the same underlying signal, just simpler: no entry
   * means either never spawned, exited, or a spawn error, and the mobile
   * client doesn't need to tell those apart the way the desktop UI does. */
  function isAlive(id: string): boolean {
    return entries.has(id);
  }

  /** Test-only accessor (pre-release audit B7's verify coverage) — the
   * live harness has no other way to observe that `seenUrls` actually
   * stays capped at `MAX_SEEN_URLS` rather than growing forever. */
  function seenUrlsCount(id: string): number {
    return entries.get(id)?.seenUrls.size ?? 0;
  }

  return { spawn, write, resize, interrupt, kill, killAll, isAlive, seenUrlsCount };
}
