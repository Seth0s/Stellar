import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import * as pty from "node-pty";
import { resolveSpawn, providerInstallCommand, providerById, shouldImposeSessionId, type SpawnOpts } from "./providers";
import { effectivePath, applyEffectiveLocaleEnv, realNodePath } from "./user-env";
import { watchForSession, claimSessionId, releaseSessionId, RESUME_TRIGGER_COMMANDS, REARM_ON_INPUT_PROVIDERS, getResumeTargetEvidence } from "./session-watch";
import { decideRearmOnLine, CLAIMED_SESSION_STALE_MS } from "./session-rearm-decision";
import { decideResumeValidity } from "./session-resume-validation";
import { decideBashCardDiscovery } from "./bash-discovery-decision";
import { decideCardIdentityEnv } from "./card-spawn-env-decision";
import {
  renewsHumanInputGateClock,
  initialBracketedPasteModeState,
  updateBracketedPasteMode,
  type BracketedPasteModeState,
  type DeliveryWriteOrigin,
} from "./type-and-submit-decision";

// DESIGN-BACKLOG.md, achado 2 (2026-09-11) — encaminhamento 3. Só os
// providers com conceito de sessão têm onde checar (mesmo conjunto que
// `watchForSession` já reconhece); `bash` nunca teve `resumeId` de
// verdade, e validar contra um provider sem noção de sessão não faz
// sentido nenhum.
const PROVIDERS_WITH_SESSION_CONCEPT = new Set(["claude", "codex", "cursor", "antigravity", "opencode"]);

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

/** Origem da escrita — espelho de `DeliveryWriteOrigin`. Sem default em
 * `write()`: omitir o parâmetro reintroduzia o bug (toda resposta
 * automática do xterm virava tecla humana). Callers must pass explicitly. */
export type PtyWriteOrigin = DeliveryWriteOrigin;

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
  /** Sticky item "card_status idle" (2026-09-03) — timestamp da última
   * vez que o processo mandou QUALQUER dado, atualizado na chegada crua
   * (`proc.onData`), não no `flush` debounced — a única forma de
   * `card_status` distinguir "trabalhando" de "vivo mas parado no
   * prompt" sem precisar entender a UI de nenhum provider específico. */
  lastActivityAt: number;
  /** DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
   * caixa sem submeter" — timestamp do SPAWN em si, guardado no próprio
   * `entry` (antes só existia como `const spawnedAtMs` local, nunca
   * exposto) porque `typeAndSubmit`'s portão de prontidão
   * (`type-and-submit-decision.ts`'s `decideWriteReadiness`) precisa dele
   * bem depois do spawn, de um closure diferente — mesmo motivo de
   * `providerId`/`cwd` logo abaixo. */
  spawnedAtMs: number;
  /** DESIGN-BACKLOG.md §0, mesmo item — `true` assim que o processo
   * emitir o PRIMEIRO byte de output, nunca mais volta a `false`.
   * Distinto de `lastActivityAt` de propósito: aquele é atualizado a CADA
   * chunk (inclusive o primeiro) e reflete só "há quanto tempo desde a
   * última vez", então sozinho não diz se algum dado já chegou ou se o
   * processo simplesmente nunca desenhou nada ainda — a pergunta exata
   * que o portão de prontidão precisa responder antes de digitar. */
  hasReceivedData: boolean;
  /** Needed to re-arm `watchForSession` from `write()` below on a detected
   * `/resume` — the original spawn call already has these, but `write()`
   * runs long after, in a different closure. */
  providerId: string;
  cwd: string;
  /** Acumula bytes de INPUT humano (não output) até a próxima quebra de
   * linha. Além de checar resume, o porteiro usa a não-vazio como sinal de
   * que o usuário começou uma linha. Escritas de `typeAndSubmit` são
   * marcadas como `delivery` e não entram aqui. O buffer existe para TODO
   * provider, não só os que têm `rearmsOnInput`, e nunca cresce sem limite
   * (ver `write`). */
  inputLineBuffer: string;
  /** Momento da ÚLTIMA tecla humana nesta linha aberta. Cada tecla renova;
   * o porteiro trata idle desde este instante, não desde o começo da linha.
   * `null` quando o último input drenou o buffer com Enter. */
  inputLineLastAtMs: number | null;
  /** DESIGN-BACKLOG.md §0 entrega duplicada rodada 4 — DECSET 2004
   * pedido pelo peer no stream de output. `typeAndSubmit` só envelopa
   * bracketed paste quando isto está `enabled`; na dúvida manda cru. */
  bracketedPasteMode: BracketedPasteModeState;
  /** Se `true`, bytes humanos são retidos brevemente enquanto uma entrega
   * já iniciada termina o ciclo texto + Enter + confirmação. Assim uma tecla
   * que chega durante a janela de 80/250ms não entra no mesmo submit. */
  deliveryActive: boolean;
  deferredHumanInput: string[];
  /** Review adversarial RODADA 5 (2026-09-10), achado único (os 3 do
   * reviewer eram sintomas do mesmo problema) — `entry` não guardava
   * NENHUM estado de "já achei a sessão", então RODADA 3's "rearma em toda
   * linha não-vazia, pra sempre" rearmava mesmo depois de já resolvido:
   * (1) poller eterno rodando `readdir`+`stat` a cada 1.5s pelo resto da
   * vida do card, sempre à toa, já que o id real já está em
   * `claimedSessionIds`; (2) `entry.stopWatch` ficava ambíguo — `null` no
   * sucesso, mas também (por outro caminho) numa expiração por timeout,
   * onde `watchForSession` só para de pollar sem zerar o campo — ninguém
   * lê esse estado hoje, mas um rearm perpétuo é o tipo de coisa que faz
   * alguém vir ler; (3) o risco real: um poller rearmado depois de
   * resolvido pode achar um `.db` NÃO reivindicado (sessão aberta à mão
   * pelo usuário fora do Stellar, mesmo cwd) e chamar `onSessionFound` de
   * novo, SOBRESCREVENDO o `resume_id` correto — o mesmo bug de "card 296
   * restaurou o conteúdo de outra sessão" que esta linha de trabalho
   * inteira existe pra fechar. `true` já na criação da entry quando
   * `spawnOpts.resumeId` já é conhecido (ver `spawn` abaixo) — um card
   * restaurado nunca teve um watcher pra achar nada, mas sem este campo
   * `write()` ainda rearmava um do ZERO nele a cada linha de input, sendo
   * esse card restaurado exatamente o alvo mais provável de sobrescrever.
   * Setado em conjunto com `stopWatch = null` nos DOIS callbacks de
   * sucesso (spawn inicial e `rearmSessionWatch`) — nunca lido sem também
   * checar `stopWatch`, mas é este campo, não aquele, que `rearmSessionWatch`
   * consulta pra decidir se vira no-op (ver seu doc comment).
   *
   * RODADA 6 (2026-09-10), achado 1 — regressão da própria RODADA 5: o
   * trigger EXPLÍCITO de resume (`RESUME_TRIGGER_COMMANDS`, ex.:
   * `/resume` do claude) existe justamente pro caso "a sessão já foi
   * achada e o usuário quer TROCAR pra outra" — checar `sessionFound`
   * ANTES desse ramo (como a RODADA 5 fazia) prendia o card na sessão
   * velha pra sempre assim que ela era resolvida uma vez, o que pra
   * `claude` é sempre (não tem `REARM_ON_INPUT_PROVIDERS`, resolve no
   * spawn). Ver `session-rearm-decision.ts`'s `decideRearmOnLine` — só o
   * ramo AUTOMÁTICO (`rearmsOnInput`) respeita `sessionFound`; o trigger
   * explícito sempre rearma E zera este campo (`write()` abaixo faz
   * `entry.sessionFound = false` quando a decisão pede), porque um
   * `/resume` de verdade É o usuário dizendo "esqueça a sessão atual". */
  sessionFound: boolean;
  /** RODADA 7 (2026-09-10), achado 3 — `true` do momento em que um
   * trigger explícito de resume dispara até a sessão ser achada de novo
   * (`sessionFound` voltar a `true`, ver o callback de sucesso de
   * `rearmSessionWatch`). Enquanto `true`, `decideRearmOnLine` rearma em
   * QUALQUER linha não-vazia, mesmo num provider fora de
   * `REARM_ON_INPUT_PROVIDERS` (é exatamente o caso do `claude`: sem
   * isto, o único watcher que um `/resume` dispara tem uma única chance
   * de `TIMEOUT_MS` — 30s — e se o usuário levar mais que isso escolhendo
   * no picker interativo, a troca de sessão se perde silenciosamente). A
   * tecla de confirmação do picker ainda cruza o PTY como um `\r` real
   * (o TUI só INTERPRETA os bytes, não os intercepta antes do processo
   * receber), então ela também conta como "linha" pra este campo manter
   * o watcher vivo até o arquivo de verdade ser escrito. */
  awaitingResumeAnyInput: boolean;
  /** RODADA 7 (2026-09-10), achado 1 — o piso ATUAL de scan, mutável
   * (ao contrário do que a RODADA 6 assumiu — ver o histórico abaixo).
   * Setado a `Date.now()` na criação da entry. `rearmSessionWatch` é o
   * único lugar que o reatribui, sempre com o `floorMs` que
   * `decideRearmOnLine` calculou (ver `write` abaixo).
   *
   * Histórico — RODADA 6 (2026-09-10), achado 2: antes daquela rodada,
   * `rearmSessionWatch` passava `Date.now()` (o momento do REARM) como
   * piso a cada chamada — o piso avançava sempre. Cenário real: `POLL_MS`
   * é 1500ms e o agy só escreve seu `.db` no submit; dois submits rápidos
   * (send_to_card dirigindo o card) podem cair na mesma janela de 1.5s —
   * o segundo rearma com um piso (T2, "agora") MAIOR que o mtime do
   * arquivo que o PRIMEIRO submit já tinha escrito em disco (T1 < T2), e
   * `findAntigravitySession`'s `st.mtimeMs <= floor` descarta esse
   * arquivo como "pré-existente" — sessão órfã. A RODADA 6 corrigiu isso
   * fixando o piso no momento do SPAWN, pra sempre, imutável.
   *
   * RODADA 7, achado 1 (reviewer contra a própria recomendação da RODADA
   * 6) — um piso fixo no spawn é um sequestro de sessão externa esperando
   * pra acontecer: um card ocioso por 2h, alguém abre um `agy`/`claude`
   * NUM TERMINAL FORA do Stellar no mesmo cwd, e uma única linha digitada
   * no card do Stellar depois disso rearma buscando qualquer arquivo com
   * `mtime > T_spawn` (horas atrás) — a sessão externa, criada há 1h,
   * bate o critério e é reivindicada na hora. Trocamos uma corrida de
   * 1.5s por uma de horas. A regra certa distingue os dois casos por UMA
   * coisa: existe um watcher REALMENTE em voo agora (`entry.stopWatch !==
   * null`) no momento do rearm? Em voo (os dois submits rápidos — o
   * anterior ainda está polando, não expirou) → mantém o piso atual, só
   * estende o PRAZO. Sem nada em voo (expirou de tanto ficar ocioso, ou
   * nunca existiu) → um piso NOVO em `Date.now()`, porque isto é de fato
   * uma tentativa nova, e tudo que nasceu durante a ociosidade deve ficar
   * de fora. Só é possível confiar em `stopWatch !== null` como esse
   * sinal agora que `watchForSession` (session-watch.ts) tem seu próprio
   * `onTimeout` — antes, uma expiração por prazo deixava `stopWatch` com
   * uma função obsoleta, indistinguível de "ainda vivo". */
  scanFloorMs: number;
  /** RODADA 7 (2026-09-10), achado 2 — o id de sessão que ESTE card tem
   * reivindicado agora (`claimSessionId`, session-watch.ts), ou `null`
   * antes de qualquer claim. `claimSessionId` nunca teve um "pop": um
   * card que troca de sessão via `/resume` reivindicava a NOVA id (dentro
   * de `watchForSession`) mas a ANTIGA, agora abandonada, ficava
   * reivindicada pra sempre neste processo — nenhum card futuro
   * conseguiria descobrir aquele arquivo de novo. Rastreado por-entry
   * (não globalmente) porque cada id só pertence a UM card de cada vez —
   * é exatamente essa exclusividade que deixa seguro liberar SÓ o id que
   * este mesmo campo guardava antes, no callback de sucesso de um rearm
   * por trigger (`rearmSessionWatch`), nunca um id arbitrário. */
  claimedSessionId: string | null;
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

/** Pedido ao vivo (2026-09-04) — worker local (Qwen via llama-server atrás
 * de llama-swap, ver ai memory `qwen-buun-local-server`) não deve ficar
 * de pé o tempo todo: fica vivo enquanto pelo menos um card `opencode`
 * (o único provider hoje configurado pra falar com ele) estiver aberto, e
 * llama-swap descarrega o processo assim que o último fechar — sem TTL,
 * porque um TTL de inatividade derrubaria o modelo NO MEIO de uma sessão
 * longa com pausas entre tool calls, pagando cold-start (~40s) de novo a
 * cada pausa em vez de uma vez só por invocação do agente. Contagem por
 * id (não um contador cru) pra sobreviver a um card fechando duas vezes
 * ou a uma entrada que nunca chegou a existir de verdade. */
const OPENCODE_LLAMA_SWAP_UNLOAD_URL = "http://127.0.0.1:8080/api/models/unload/Qwen3.6-27B-IQ3-MTP";
const openOpencodeCardIds = new Set<string>();

function notifyLastOpencodeCardClosed(): void {
  // Fire-and-forget — nunca bloqueia nem falha o fechamento do card por
  // isso. llama-swap pode nem estar rodando (setup opcional); um erro
  // aqui só significa que o worker fica carregado até a próxima chamada
  // de unload ou até alguém derrubar o processo na mão.
  fetch(OPENCODE_LLAMA_SWAP_UNLOAD_URL, { method: "POST" }).catch(() => {});
}

export function createPtyRegistry(registryOpts: {
  onData: (id: string, data: string) => void;
  onExit: (id: string, exitCode: number) => void;
  onSessionFound: (id: string, sessionId: string) => void;
  /** Review adversarial (2026-09-11), achado 4 — o primeiro conserto daqui
   * escrevia o aviso direto em `onData` (bytes injetados no próprio pty).
   * PROVADO ruim: TUIs em tela cheia (claude, opencode) mandam clear/redraw
   * absoluto no boot — o aviso ou é apagado antes de ser lido, ou corrompe
   * o desenho. Mesma raiz do bug documentado no backlog ("texto entregue a
   * um card recém-spawnado fica na caixa sem submeter") — escrever no pty
   * sem saber se o destino está "pronto" pra receber. Canal separado da
   * saída do processo: chega no rodapé do card (`TerminalCard.tsx`, DOM de
   * verdade, nunca faz parte do grid de caracteres que a TUI redesenha) —
   * sobrevive a qualquer clear/redraw porque nunca esteve no buffer do
   * terminal. `electron.Notification` continua fora de cogitação (já
   * documentado como estruturalmente invisível pra um agente dentro de um
   * PTY). */
  onResumeInvalid: (id: string, reason: "missing" | "empty", staleResumeId: string) => void;
  onUrlSeen: (id: string, url: string) => void;
  /**
   * Fila derived status (CAMADA 3) depends on `isAlive`, but the renderer
   * is push-never-poll for `task:changed`. Task-row writers alone never
   * see a PTY birth/death. Measured 2026-09-14: spawn_agent links
   * `tasks.card_id` and pushes WHILE the TerminalCard has not yet called
   * `pty:spawn` (`resolveAgent` returns from `addCard`, PTY mounts later),
   * so that push freezes `cardAlive=false`; `onExit` never pushed at all.
   * One source — the Map transitions that DEFINE `isAlive` — invalidates
   * the Fila. Idempotent: a second `drop` (kill immediate then real
   * `onExit`) does not re-fire.
   */
  onLivenessChanged?: (id: string, alive: boolean) => void;
  /** Path to the acbridge Unix socket, and the dir it lives in — injected into every spawned provider's env/PATH. */
  sockPath: string;
  binDir: string;
  /** DESIGN-BACKLOG.md item 21, ponto 9 — the MCP server's own base URL
   * (mcp-server.ts), threaded into `SpawnOpts.mcpUrl` for every spawn so
   * `providers.ts::buildArgs` can register it per-provider. */
  mcpUrl: string;
}) {
  const entries = new Map<string, Entry>();

  /** Sole writers of the liveness Map — `isAlive` is `entries.has`. */
  function adoptEntry(id: string, entry: Entry): void {
    const wasAlive = entries.has(id);
    entries.set(id, entry);
    if (!wasAlive) registryOpts.onLivenessChanged?.(id, true);
  }
  function dropEntry(id: string): boolean {
    if (!entries.has(id)) return false;
    entries.delete(id);
    registryOpts.onLivenessChanged?.(id, false);
    return true;
  }

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
    | { id: string; consumedBrief?: boolean }
    /** `searchedPath` pedido por nome no depoimento de um usuário de macOS
     * (2026-09-08): "mensagem de erro atual não informa qual PATH foi
     * usado na busca — dificulta diagnóstico pelo usuário final". Sem
     * isto, um `binary_not_found` é indistinguível de uma CLI realmente
     * ausente, e foi preciso engenharia reversa do `app.asar` para
     * descobrir que o PATH pesquisado não era o da login shell. */
    | { error: "binary_not_found"; providerId: string; installCommand: string | null; searchedPath: string }
    | { error: "spawn_failed"; providerId: string } {
    // Carimba a identidade do card na URL do MCP registrada PRA ESTE
    // processo — ver o doc de `buildServer` em mcp-server.ts: sem isso o
    // servidor MCP (um só, compartilhado por todos os cards) dependia do
    // modelo lembrar de preencher `callerCardId`, e quando ele não
    // lembrava o modo autônomo do board simplesmente não valia. Mesmo id
    // do `AGENT_CANVAS_CARD_ID` logo abaixo, mesma fonte.
    // DESIGN-BACKLOG.md, achado 2 (2026-09-11) — encaminhamento 3: nunca
    // honrar um `resumeId` restaurado sem checar primeiro que existe algo
    // de verdade por trás dele. Achado ao vivo que motivou isto: card 330
    // restaurou com `resume_id` apontando pro arquivo de um spawn travado
    // (2550 bytes, nunca cresceu) em vez da sessão de 15.9 MB de fato em
    // uso — um `--resume` silencioso pra uma sessão vazia, sem AVISO
    // NENHUM. `resumeInvalidReason` não-nulo é o único sinal que o resto
    // desta função precisa: dali em diante trata como se `resumeId` nunca
    // tivesse vindo preenchido (spawn limpo, watcher normal arma sozinho),
    // e um aviso visível chega pelo canal dedicado `onResumeInvalid` (ver
    // seu doc comment acima — NÃO é mais escrito no pty do card: uma
    // primeira versão fazia isso e uma review adversarial provou que uma
    // TUI em tela cheia apaga ou corrompe qualquer coisa escrita ali antes
    // do próprio boot dela terminar).
    let resumeInvalidReason: "missing" | "empty" | null = null;
    if (spawnOpts.resumeId && PROVIDERS_WITH_SESSION_CONCEPT.has(providerId)) {
      const evidence = getResumeTargetEvidence(providerId, cwd, spawnOpts.resumeId);
      // Stale-vs-wall-clock is NOT applied here on purpose: a legitimate
      // overnight `--resume` has an old mtime and must still load. Cause 2
      // of "envelhece sozinho" is handled by (1) `decideResumeValidity`'s
      // optional `referenceActivityMs` when a caller actually has card
      // activity, and (2) `decideRearmOnLine`'s stale-claim path which
      // renews the stamp while the card is alive — so the next restart
      // already points at the live file. Spawning with Date.now() as the
      // reference would refuse every idle-but-correct session.
      const validity = decideResumeValidity(evidence);
      if (!validity.valid) {
        // `stale` cannot appear without referenceActivityMs; narrow for
        // the onResumeInvalid channel (missing | empty only).
        if (validity.reason === "missing" || validity.reason === "empty") {
          resumeInvalidReason = validity.reason;
        }
      }
    }
    const effectiveSpawnOpts: SpawnOpts = resumeInvalidReason ? { ...spawnOpts, resumeId: undefined } : spawnOpts;
    // Measured 2026-09-13: claude/cursor accept a caller-chosen UUID.
    // Generate it HERE (not inside buildArgs) so we can persist
    // `resume_id` on the same spawn tick — the watcher does not run for
    // an imposed id. Skip when restoring or `--continue`.
    const imposedSessionId = shouldImposeSessionId(providerId, effectiveSpawnOpts)
      ? randomUUID()
      : undefined;

    const cardMcpUrl = registryOpts.mcpUrl ? `${registryOpts.mcpUrl}?card=${encodeURIComponent(id)}` : registryOpts.mcpUrl;
    // DESIGN-BACKLOG.md §0 — capacity-derived report discovery. Refuse
    // before resolveSpawn when the provider has no path to teach report
    // (spawnBlock). Scrollback tip is applied after a successful spawn.
    const discovery = decideBashCardDiscovery({ providerId });
    if (discovery.spawnBlock) {
      return { error: "spawn_failed", providerId };
    }

    const resolved = resolveSpawn(providerId, { ...effectiveSpawnOpts, mcpUrl: cardMcpUrl, imposedSessionId });
    if (!resolved) {
      return {
        error: "binary_not_found",
        providerId,
        installCommand: providerInstallCommand(providerId),
        searchedPath: effectivePath(),
      };
    }

    const inheritedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || isInheritedClaudeSessionEnvKey(key)) continue;
      inheritedEnv[key] = value;
    }

    const env: Record<string, string> = {
      // Same launchd hole as PATH (user-env.ts): a Finder `.app` arrives
      // with LANG/LC_* absent and every PTY becomes C/US-ASCII. Decision
      // is `locale-env-decision.ts`; apply (not a writes spread) so an
      // LC_ALL unset actually removes the key instead of leaving the
      // inherited C / POSIX / US-ASCII lock in place.
      ...applyEffectiveLocaleEnv(inheritedEnv),
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
      // Interpretador para os shims de `resources/bin` (`stellar-mcp`,
      // `acbridge`) rodarem (2026-09-08). Preferência (2026-09-09):
      // `realNodePath()` — um `node` real e JÁ VALIDADO (achado no PATH
      // efetivo, major >= MIN_REAL_NODE_MAJOR confirmada por execução
      // real, não só por existência do arquivo; ver
      // user-env.ts::resolveRealNode e o piso ancorado no que os shims
      // realmente usam) — porque
      // reexecutar o binário do Electron como Node custa ~35 MB de RSS a
      // mais por processo (medido ao vivo nesta máquina: node real 51 MB
      // vs. Electron+ELECTRON_RUN_AS_NODE 86 MB), e cada card do board
      // carrega um `stellar-mcp` de longa vida. O fallback para
      // `process.execPath` continua existindo porque `node` pode
      // simplesmente não estar no PATH — num `.app` aberto pelo Finder no
      // macOS não há, o mesmo motivo pelo qual o shebang `#!/usr/bin/env
      // node` do `acbridge` morre nesse cenário — e é por isso que o
      // binário do Electron precisa seguir sendo o piso que sempre
      // funciona. Chega aos shims por herança: PTY → CLI do provider →
      // shim.
      AGENT_CANVAS_NODE: realNodePath() ?? process.execPath,
      // Stable facts the app already knows at spawn (card-spawn-env-
      // decision.ts). `AGENT_CANVAS_CWD` is the card's official workspace
      // (list_cards compares against this, not a later `cd`).
      // `AGENT_CANVAS_TASK_ID` only when this spawn was tied to a task —
      // omitted entirely otherwise, so a task-less card is not a second-
      // class path. Who else is alive in this cwd, and whether the board
      // is autonomous, change during the session: those stay on
      // `list_cards` / `board_mode`, not a birth snapshot in env.
      ...decideCardIdentityEnv({ taskId: spawnOpts.taskId, cwd }),
      // `effectivePath()` e não `process.env.PATH` (2026-09-08): num
      // `.app` aberto pelo Finder no macOS, o PATH herdado é o mínimo do
      // launchd, e era ELE que todo PTY do board recebia — nenhum agente
      // conseguia rodar `node`, `brew`, `cargo` ou o próprio `acbridge`
      // (cujo shebang é `#!/usr/bin/env node`). Ver user-env.ts.
      PATH: `${registryOpts.binDir}${delimiter}${effectivePath()}`,
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

    // RODADA 6, achado 2 (nome atualizado na RODADA 7 — ver `scanFloorMs`
    // no `Entry`) — capturado UMA vez e reaproveitado tanto no piso
    // inicial da entry quanto na primeira chamada de `watchForSession`
    // abaixo, pra não ter dois `Date.now()` levemente diferentes fingindo
    // ser "o mesmo instante do spawn".
    const spawnedAtMs = Date.now();

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
      lastActivityAt: spawnedAtMs,
      spawnedAtMs,
      hasReceivedData: false,
      providerId,
      cwd,
      inputLineBuffer: "",
      inputLineLastAtMs: null,
      bracketedPasteMode: initialBracketedPasteModeState(),
      deliveryActive: false,
      deferredHumanInput: [],
      // RODADA 5, achado único — um card restaurado (`resumeId` já
      // conhecido) nunca teve nada a descobrir: já é "resolvido" desde
      // antes do primeiro `write()`, então nenhuma linha de input deveria
      // jamais armar um watcher do zero nele (ver o doc comment do campo
      // em `Entry` acima). Um card fresco começa `false` e vira `true`
      // assim que o callback de sucesso abaixo (ou o de
      // `rearmSessionWatch`) rodar.
      sessionFound: !!(effectiveSpawnOpts.resumeId || imposedSessionId),
      // RODADA 7, achado 3 — nunca começa `true`: o modo "qualquer input
      // rearma" só liga quando um trigger explícito dispara (write()
      // abaixo), nunca no spawn.
      awaitingResumeAnyInput: false,
      scanFloorMs: spawnedAtMs,
      // RODADA 7, achado 2 — já preenchido quando o card nasce restaurado
      // (`effectiveSpawnOpts.resumeId`), pra `rearmSessionWatch` ter o que
      // liberar no dia em que este card trocar de sessão via `/resume`.
      claimedSessionId: effectiveSpawnOpts.resumeId ?? imposedSessionId ?? null,
    };
    adoptEntry(id, entry);
    if (providerId === "opencode") openOpencodeCardIds.add(id);

    // Review adversarial (2026-09-11), achado 4 — isto disparava via
    // `registryOpts.onData(id, banner)` antes, bytes crus no pty. Trocado
    // pelo canal dedicado (ver o doc comment de `onResumeInvalid` acima) —
    // depois de `entries.set` pelo mesmo motivo de sempre (consumidores
    // reconhecerem o id), mas nunca toca o buffer do terminal.
    if (resumeInvalidReason) {
      registryOpts.onResumeInvalid(id, resumeInvalidReason, spawnOpts.resumeId!);
    }

    // DESIGN-BACKLOG.md §0 / §2.1 — capacity-derived discovery tip.
    // Intent: one-shot tip in scrollback when deriveReportDiscovery says
    // scrollback (or the bash nested-agent tip). Delivered through the
    // renderer's onData path, NOT via --rcfile/--init-file and NOT via
    // shell stdin. Does NOT teach a hand-launched nested agent inside
    // bash (no system-prompt/MCP injection without wrapping binaries —
    // rejected).
    if (discovery.scrollbackTip) {
      queueMicrotask(() => {
        if (!entries.has(id)) return;
        registryOpts.onData(id, `\r\n${discovery.scrollbackTip}\r\n`);
      });
    }

    // Only watch for a fresh session when the caller didn't already pass a
    // (valid) resumeId — a spawn that already targets a known session has
    // nothing to discover. But that known session's id still needs to be
    // claimed (see claimSessionId's doc comment) — otherwise a fresh
    // watcher for a different, later-spawned card in the same cwd can
    // "discover" and steal this restored card's own in-use session file,
    // since nothing else ever marks it as belonging to someone.
    if (imposedSessionId) {
      // Known at spawn — persist immediately. No watcher.
      claimSessionId(imposedSessionId);
      registryOpts.onSessionFound(id, imposedSessionId);
    } else if (!effectiveSpawnOpts.resumeId) {
      entry.stopWatch = watchForSession(
        providerId,
        cwd,
        spawnedAtMs,
        (sessionId) => {
          entry.stopWatch = null;
          entry.sessionFound = true;
          entry.awaitingResumeAnyInput = false;
          entry.claimedSessionId = sessionId;
          registryOpts.onSessionFound(id, sessionId);
        },
        // Kept for signature compatibility. Discovery no longer times
        // out; this callback never fires. Rearm still cancels via stop().
        () => {
          entry.stopWatch = null;
          entry.awaitingResumeAnyInput = false;
        },
      );
    } else {
      claimSessionId(effectiveSpawnOpts.resumeId);
    }

    proc.onData((data) => {
      entry.lastActivityAt = Date.now();
      entry.hasReceivedData = true;
      // Rodada 4 (`49ae26b7`) — track DECSET 2004h/l so deliveries only
      // wrap bracketed paste when the peer asked. Pure update; no I/O.
      entry.bracketedPasteMode = updateBracketedPasteMode(entry.bracketedPasteMode, data);
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
      // RODADA 9 (2026-09-10), achado único — a contagem de referências da
      // RODADA 8 (achado 2) resolvia a troca de sessão via `/resume`, mas
      // nunca liberava a claim de um card FECHADO: `entries.delete` abaixo
      // já existia, `releaseSessionId` nunca era chamado aqui — todo card
      // fechado abandonava sua sessão com a contagem > 0 pra sempre no
      // Map global, invisível pra qualquer watcher novo pelo resto do
      // uptime do app. O achado 2 da RODADA 7 (id preso pra sempre)
      // voltando por uma 3ª porta: 1ª vez sem release nenhum, 2ª vez com
      // release sem refcount, agora com refcount sem decremento no
      // caminho de morte.
      //
      // `proc.onExit` é o ÚNICO lugar que libera — nunca `kill` (abaixo)
      // — porque é a ÚNICA notificação que dispara exatamente uma vez por
      // processo real, não importa qual dos caminhos levou até aqui:
      // saída natural, escalada de sinais do `kill` gracioso (unmount de
      // card — o único lugar do renderer que mata um PTY, `useTerminal.ts`
      // — e por extensão troca de board, que só desmonta os cards da
      // anterior, mesmo caminho), ou o SIGKILL imediato de `killAll` (saída
      // do app). `kill(immediate: true)` já faz seu próprio
      // `entries.delete` síncrono (bookkeeping pro `isAlive` responder na
      // hora, sem esperar o evento assíncrono) — mas isso NUNCA pula este
      // callback: node-pty ainda dispara `onExit` de verdade quando o
      // processo (morto pelo SIGKILL que `kill` acabou de mandar) sai, e é
      // só aqui, com o `entry` fechado por closure (não um
      // `entries.get(id)`, que a essa altura já pode estar vazio), que a
      // claim é liberada. Um único ponto de liberação por processo real —
      // nunca zero, nunca dois — é o que evita tanto o vazamento (não
      // chamar) quanto o duplo decremento (chamar duas vezes, que
      // desprotegeria uma sessão com outro card ainda usando — ver o
      // comentário de `releaseSessionId`, achado 2 da RODADA 8).
      if (entry.claimedSessionId) releaseSessionId(entry.claimedSessionId);
      // O ÚNICO lugar que remove uma entrada no caminho normal. `kill`
      // gracioso NÃO remove por conta própria: enquanto o processo não
      // sai de verdade, ele continua no registry e `isAlive` continua
      // dizendo a verdade. `kill({immediate:true})` (fechamento do app)
      // é a exceção — drop síncrono lá, e este `dropEntry` vira no-op.
      entry.deliveryActive = false;
      entry.deferredHumanInput = [];
      dropEntry(id);
      if (openOpencodeCardIds.delete(id) && openOpencodeCardIds.size === 0) notifyLastOpencodeCardClosed();
      registryOpts.onExit(id, exitCode);
    });

    const providerDef = providerById(providerId);
    const consumedBrief = providerDef?.capacity.delivery.briefMechanism !== "none";
    return { id, consumedBrief };
  }

  // Achado ao vivo (2026-09-07) — ver RESUME_TRIGGER_COMMANDS em
  // session-watch.ts: cap curto porque um trigger reconhecido é sempre um
  // slash command curto; nunca deixa entrada binária/colada sem quebra de
  // linha crescer o buffer pra sempre. Reaproveitado pro
  // REARM_ON_INPUT_PROVIDERS tracking (achado 1, RODADA 2/3) sem
  // aumentar: uma linha de verdade longa (um briefing inteiro de
  // `send_to_card`) pode ser truncada aqui, mas o único uso desse caminho
  // é "esta linha tem algum conteúdo não-vazio?" — um fragmento truncado
  // ainda serve pra essa checagem, então não precisa de um cap maior.
  const MAX_INPUT_LINE_BUFFER = 64;

  /** Review adversarial RODADA 3 (2026-09-09), achado 1 — confirmadamente
   * idempotente e seguro pra chamar em toda linha de input, não só uma
   * vez: `entry.stopWatch?.()` sempre cancela o watch anterior (seu
   * `clearInterval`/`clearTimeout` internos, ver `watchForSession`)
   * ANTES de armar um novo, mesmo se o anterior já tiver parado sozinho
   * (achou ou deu timeout) — nunca vaza timer, nunca empilha um segundo
   * poller rodando em paralelo com o novo.
   *
   * RODADA 6 (2026-09-10), achado 3 — a RODADA 5 tinha aqui um
   * `if (entry.sessionFound) return;` como "defesa em profundidade".
   * Removido: com o fix do achado 1 daquela rodada (`write()`/
   * `decideRearmOnLine`), o único chamador já GARANTE `entry.sessionFound
   * === false` em toda chamada — pelo ramo automático (só chama quando já
   * era `false`) ou pelo trigger explícito (`write()` zera o campo ANTES
   * de chamar, nunca depois). Um guard que nunca mais executa é comentário
   * disfarçado de código; se um novo chamador aparecer no futuro violando
   * essa garantia, é ELE que precisa decidir, não esta função adivinhar.
   *
   * `floorMs` — RODADA 7, achado 1 — o piso que `write()`/
   * `decideRearmOnLine` decidiu pra ESTA chamada (ver o doc comment de
   * `Entry.scanFloorMs` pro histórico completo: piso fixo no spawn foi a
   * recomendação da RODADA 6, e sequestrava sessão externa depois de um
   * card ficar ocioso por horas — a regra certa é "reusa o piso atual só
   * se um watcher ainda estava em voo, senão recalcula a partir de
   * agora"). Persistido de volta em `entry.scanFloorMs` AQUI, não em
   * `write()` — este é o único lugar que de fato liga um watcher novo,
   * então é o único lugar que sabe com certeza qual piso passou a valer. */
  function rearmSessionWatch(id: string, entry: Entry, floorMs: number, rearmAtMs: number) {
    entry.stopWatch?.();
    entry.scanFloorMs = floorMs;
    entry.stopWatch = watchForSession(
      entry.providerId,
      entry.cwd,
      floorMs,
      (sessionId) => {
        entry.stopWatch = null;
        entry.sessionFound = true;
        entry.awaitingResumeAnyInput = false;
        // RODADA 7, achado 2 — libera o id ANTIGO deste card (se algum),
        // só depois de confirmar que um novo já tomou seu lugar, nunca
        // antes (enquanto o `/resume` ainda está em aberto no picker, o
        // card continua efetivamente usando a sessão velha, cancelável).
        if (entry.claimedSessionId && entry.claimedSessionId !== sessionId) {
          releaseSessionId(entry.claimedSessionId);
        }
        entry.claimedSessionId = sessionId;
        registryOpts.onSessionFound(id, sessionId);
      },
      // RODADA 8, achado 3 — sem `awaitingResumeAnyInput = false` aqui,
      // um `/resume` abandonado (Esc no picker, nunca confirmado) deixava
      // `awaiting = true` e `sessionFound = false` presos pro resto da
      // vida do card: TODO input dali em diante (mesmo conversa normal,
      // nada a ver com resume) cairia no ramo automático de
      // `decideRearmOnLine` e levantaria um poller de 30s inteiro à toa
      // — o poller eterno da RODADA 5 reaberto por outra porta. Esta é a
      // expiração que de fato acontece nesse cenário (o watcher que o
      // trigger armou simplesmente não achou nada dentro do prazo), então
      // é aqui, não no `onTimeout` do spawn acima, que o achado realmente
      // se fecha.
      () => {
        entry.stopWatch = null;
        entry.awaitingResumeAnyInput = false;
      },
      {
        ownerId: id,
        rearmAtMs,
        // When a watcher is already in flight, `floorMs` stays pinned
        // (two fast submits). Ownership lower bound must use that same
        // floor so the first submit's file is still attributable. A
        // brand-new attempt uses `rearmAtMs` (= floorMs when nothing
        // was in flight).
        matchStartMs: floorMs,
      },
    );
  }

  function recordHumanInput(id: string, entry: Entry, data: string) {
    if (data.length === 0) return;
    // Bufferiza para o porteiro em TODO provider; a decisão de sessão
    // continua usando apenas os dois caminhos abaixo.
    // RESUME_TRIGGER_COMMANDS), ou (review adversarial RODADA 2/3,
    // 2026-09-09) um provider em REARM_ON_INPUT_PROVIDERS.
    const trigger = RESUME_TRIGGER_COMMANDS[entry.providerId];
    const rearmsOnInput = REARM_ON_INPUT_PROVIDERS.includes(entry.providerId);
    // RODADA 7, achado 3 — `entry.awaitingResumeAnyInput` (abaixo) faz
    // QUALQUER linha rearmar, mesmo num provider sem `rearmsOnInput`
    // próprio (o caso do achado: claude) — mas NÃO precisa entrar neste
    // `if` como uma 3ª condição: só liga (`decideRearmOnLine`'s
    // `enterAwaitingResumeAnyInput`) dentro do ramo do trigger explícito,
    // que já exige `trigger` truthy — e `trigger` é estático por
    // providerId, então pra QUALQUER entry ele nunca muda de valor entre
    // chamadas. Ou seja: sempre que `awaitingResumeAnyInput` puder ser
    // `true`, `trigger` já é (e continua sendo) `true` pra esse mesmo
    // provider — checá-lo de novo aqui seria uma condição que nunca muda
    // o resultado, código morto disfarçado de defesa.
    const nowMs = Date.now();
    // Renova em CADA tecla humana, não só na primeira da linha — o teto do
    // porteiro é "parou de digitar há N ms", não "começou a digitar há N ms".
    entry.inputLineLastAtMs = nowMs;
    entry.inputLineBuffer += data;
    let newlineIdx: number;
      // RODADA 7, achado 1 — um `Date.now()` só, reaproveitado por TODAS
      // as linhas deste `write()` (um paste multi-linha pode conter
      // várias) — a diferença de alguns microssegundos entre linhas do
      // mesmo `write()` é irrelevante pro piso, e usar o MESMO valor
      // evita qualquer ambiguidade sobre "qual now" uma linha específica
      // viu.
    while ((newlineIdx = entry.inputLineBuffer.search(/[\r\n]/)) !== -1) {
        const line = entry.inputLineBuffer.slice(0, newlineIdx).trim();
        entry.inputLineBuffer = entry.inputLineBuffer.slice(newlineIdx + 1);
        entry.inputLineLastAtMs = entry.inputLineBuffer.length > 0 ? nowMs : null;
        // RODADA 6, achado 1 (correção de regressão da RODADA 5) — a
        // decisão distingue os DOIS caminhos, que são coisas diferentes:
        // o trigger EXPLÍCITO (`/resume`) sempre rearma, mesmo com a
        // sessão já resolvida — é o usuário pedindo pra TROCAR — e por
        // isso também ZERA `sessionFound` (`resetSessionFound`, aplicado
        // ANTES de rearmar, nunca depois) e LIGA o modo "qualquer input
        // rearma" (RODADA 7, achado 3, `enterAwaitingResumeAnyInput`); o
        // ramo AUTOMÁTICO (`rearmsOnInput` OU já dentro desse modo)
        // continua obedecendo `sessionFound` como antes.
        //
        // Achado 1, RODADA 3 — TODA linha não-vazia rearma, não só a
        // primeira (pelo ramo automático, enquanto a sessão não tiver
        // sido achada): uma rodada anterior rearmava uma vez só (guardado
        // por uma flag por-card), o que reiniciava o relógio cedo demais
        // numa colagem multi-linha (shift+enter) e podia expirar de novo
        // antes do submit final — a mesma classe de bug que esta correção
        // existe pra fechar, só adiada. "A janela conta a partir da
        // última atividade real do card" é a semântica pedida — barato o
        // bastante pra rodar em toda linha (`rearmSessionWatch` é
        // idempotente, ver seu doc comment), sem flag de "já vi a
        // primeira" nenhuma. `line.length > 0` continua excluindo um
        // Enter vazio (não conta como atividade real).
        const claimedSessionMtimeMs = entry.claimedSessionId
          ? (getResumeTargetEvidence(entry.providerId, entry.cwd, entry.claimedSessionId).mtimeMs ?? null)
          : null;
        const decision = decideRearmOnLine({
          line,
          trigger,
          rearmsOnInput,
          sessionFound: entry.sessionFound,
          awaitingResumeAnyInput: entry.awaitingResumeAnyInput,
          watcherInFlight: entry.stopWatch !== null,
          currentFloorMs: entry.scanFloorMs,
          nowMs,
          claimedSessionMtimeMs,
          claimedSessionStaleMs: CLAIMED_SESSION_STALE_MS,
        });
        if (decision.action === "rearm") {
          if (decision.resetSessionFound) entry.sessionFound = false;
          if (decision.enterAwaitingResumeAnyInput) entry.awaitingResumeAnyInput = true;
          rearmSessionWatch(id, entry, decision.floorMs, nowMs);
        }
      }
    if (entry.inputLineBuffer.length > MAX_INPUT_LINE_BUFFER) {
      entry.inputLineBuffer = entry.inputLineBuffer.slice(-MAX_INPUT_LINE_BUFFER);
    }
    if (entry.inputLineBuffer.length === 0) entry.inputLineLastAtMs = null;
  }

  function write(id: string, data: string, origin: PtyWriteOrigin) {
    const entry = entries.get(id);
    if (!entry) return;

    // Uma entrega já começou depois de passar pelo porteiro. Reter bytes
    // humanos durante o pequeno ciclo texto+Enter+confirmação evita que uma
    // tecla que chegue na janela de confirmação seja submetida junto com o
    // aviso. A ordem dos bytes é preservada; `endDelivery` devolve-os via
    // `write(..., "human")` e o bus emite o aviso de entrada — eram
    // humanas ao adiar, continuam humanas ao despejar.
    // `"auto"` (mouse/CPR/focus) NÃO entra aqui: a TUI precisa das
    // respostas do emulador mesmo no meio de uma entrega.
    if (renewsHumanInputGateClock(origin) && entry.deliveryActive) {
      entry.deferredHumanInput.push(data);
      return;
    }

    // Só origem humana alimenta o buffer/relógio do porteiro — `delivery`
    // e `auto` não podem renovar o idle e segurar a fila dos outros.
    if (renewsHumanInputGateClock(origin)) recordHumanInput(id, entry, data);
    entry.proc.write(data);
  }

  function beginDelivery(id: string): boolean {
    const entry = entries.get(id);
    if (!entry || entry.deliveryActive) return false;
    entry.deliveryActive = true;
    return true;
  }

  function endDelivery(id: string): { flushedHumanInput: boolean } {
    const entry = entries.get(id);
    if (!entry) return { flushedHumanInput: false };
    entry.deliveryActive = false;
    const deferred = entry.deferredHumanInput.splice(0);
    // Replay through `write` so the bytes stay origin `"human"` — same
    // gate clock, same line buffer. The caller (deliverCard) emits the
    // turn-input notice: these keys were human before they were held,
    // and they are still human after. `proc.write` alone would land in
    // the PTY with the previous turn already closed and no window.
    for (const data of deferred) {
      write(id, data, "human");
    }
    return { flushedHumanInput: deferred.length > 0 };
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
      // Bookkeeping so `isAlive` is false immediately (app quit cannot
      // wait for the async onExit). Real `proc.onExit` still fires and
      // its `dropEntry` is a no-op — one liveness edge, not two.
      dropEntry(id);
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

  /** Sticky item "card_status idle" — `null` for a card with no live
   * entry (never spawned, exited, or a spawn error) — same "no entry
   * means gone" convention as `isAlive`. */
  function getLastActivityAt(id: string): number | null {
    return entries.get(id)?.lastActivityAt ?? null;
  }

  /** PTY child pid for process-ownership identify (`/proc/<pid>/fd`). */
  function getPid(id: string): number | null {
    const entry = entries.get(id);
    if (!entry) return null;
    const pid = entry.proc.pid;
    return typeof pid === "number" && pid > 0 ? pid : null;
  }

  /** Session id this live entry already claimed (impose/resume/watcher). */
  function getClaimedSessionId(id: string): string | null {
    return entries.get(id)?.claimedSessionId ?? null;
  }

  /** DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
   * caixa sem submeter" — o snapshot que `typeAndSubmit` (message-bus.ts)
   * precisa pra decidir, via `decideWriteReadiness`
   * (type-and-submit-decision.ts), se já é seguro digitar. `null` com a
   * mesma convenção de `isAlive`/`getLastActivityAt` — sem entry, não há
   * o que esperar. */
  function getWriteReadiness(id: string): {
    spawnedAtMs: number;
    hasReceivedData: boolean;
    lastActivityAtMs: number;
    hasPendingHumanInput: boolean;
    inputLineLastAtMs: number | null;
    /** Peer requested DECSET 2004h (Bracketed Paste Mode). */
    bracketedPasteMode: boolean;
    /** Monotonic `2004l`/reset count — readline "line accepted" signal
     * for shell targets (see `BracketedPasteModeState.offEvents`). */
    bracketedPasteOffEvents: number;
  } | null {
    const entry = entries.get(id);
    if (!entry) return null;
    return {
      spawnedAtMs: entry.spawnedAtMs,
      hasReceivedData: entry.hasReceivedData,
      lastActivityAtMs: entry.lastActivityAt,
      hasPendingHumanInput: entry.inputLineBuffer.length > 0,
      inputLineLastAtMs: entry.inputLineLastAtMs,
      bracketedPasteMode: entry.bracketedPasteMode.enabled,
      bracketedPasteOffEvents: entry.bracketedPasteMode.offEvents,
    };
  }

  /** Dev/verify: dump human-input gate buffers for every live entry. */
  function dumpHumanInputGate(): Array<{
    id: string;
    providerId: string;
    hasPendingHumanInput: boolean;
    inputLineLastAtMs: number | null;
    bufferHex: string;
    bufferRepr: string;
  }> {
    const out: Array<{
      id: string;
      providerId: string;
      hasPendingHumanInput: boolean;
      inputLineLastAtMs: number | null;
      bufferHex: string;
      bufferRepr: string;
    }> = [];
    for (const [id, entry] of entries) {
      const buf = entry.inputLineBuffer;
      out.push({
        id,
        providerId: entry.providerId,
        hasPendingHumanInput: buf.length > 0,
        inputLineLastAtMs: entry.inputLineLastAtMs,
        bufferHex: Buffer.from(buf, "utf8").toString("hex"),
        bufferRepr: JSON.stringify(buf),
      });
    }
    return out;
  }

  /** Test-only accessor (pre-release audit B7's verify coverage) — the
   * live harness has no other way to observe that `seenUrls` actually
   * stays capped at `MAX_SEEN_URLS` rather than growing forever. */
  function seenUrlsCount(id: string): number {
    return entries.get(id)?.seenUrls.size ?? 0;
  }

  return { spawn, write, beginDelivery, endDelivery, resize, interrupt, kill, killAll, isAlive, getLastActivityAt, getPid, getClaimedSessionId, getWriteReadiness, dumpHumanInputGate, seenUrlsCount };
}
