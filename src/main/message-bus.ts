import { createServer, createConnection, type Server, type Socket } from "node:net";
import { unlinkSync, statSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TaskCardRow, TaskRow, ConnectorRow, ReportRow } from "./store";
import { decideReportNotifyTarget, pickLatestDirectiveSender } from "./report-notify-routing";
import { decideConnectorKindWrite } from "./connector-kind-authorization";
import { decideDeliveryGate, decideWriteReadiness, decideSubmitCheck, shouldPressEnterOnAttempt, composerClearSequence, deliveryTextBytes, deliveryWriteOpensTurn, type DeliveryWriteKind } from "./type-and-submit-decision";
import { decideTaskCardSpawn, type TaskCardGuardCard } from "../task-card-guard";
import type { StatusWriteDecision } from "./status-write-decision";
import {
  decideStatusAsk,
  describeStatusAskAlready,
  describeStatusAskParked,
  describeStatusHeldWarning,
} from "./status-write-decision";
import { decideFailureKind, decideFailureWrite, stampFailureKindJson, failureKindFromResultJson, resolveFailureKind, mergeAgentResultJson, type FailureSource } from "./failure-kind-decision";
import { resolveTaskDispatchCwd, resolveTaskDispatchLabel } from "./task-dispatch-decision";
import { applyTaskPromptWrite, type TaskPromptWriteMode } from "../task-prompt-decision";
import { navigationUrlError } from "./browser-registry";

export type SockIdentity = { dev: number; ino: number };

/** Achado 2 (review adversarial, 2026-09-09) — a decisão "o que está no
 * path agora ainda é o MESMO arquivo que eu vi antes?" é usada em dois
 * lugares deste arquivo (a sonda de EADDRINUSE antes do unlink, e o guard
 * de ownership de `close()`): mesma pergunta, mesmos dois campos (`dev` +
 * `ino`, o par que identifica um arquivo de verdade em POSIX — nome/path
 * não serve, é só onde ele mora agora). Extraída aqui, exportada, pra dar
 * pra testar a lógica em isolamento: forçar de verdade a corrida real
 * entre duas instâncias (o cenário que motiva o uso desta função na sonda)
 * não é reproduzível de forma confiável num teste automatizado — o que dá
 * pra travar é que ESTA comparação, a peça que decide "seguro apagar" vs.
 * "não mexe, notifica", está certa. `null` de qualquer lado (sem baseline,
 * ou path já sumiu) sempre conta como "não é o mesmo arquivo" — o lado que
 * chama isto trata ambos com a mesma cautela: não tem prova, não apaga. */
export function sameSockIdentity(a: SockIdentity | null, b: SockIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

const OPEN_TIMEOUT_MS = 120_000;
// Shorter than OPEN_TIMEOUT_MS on purpose — a snapshot needs no human
// decision, just a renderer round-trip + a capturePage() call. If it's
// still pending after 10s something's actually wrong (window not
// responding), not a person thinking it over.
const SNAPSHOT_TIMEOUT_MS = 10_000;
// Same reasoning as OPEN_TIMEOUT_MS — spawning a card is a human decision.
const SPAWN_TIMEOUT_MS = 120_000;
// Sticky item "close_card" (2026-09-03) — same reasoning as OPEN_TIMEOUT_MS:
// closing a card (killing a real process, for a terminal) is a human
// decision, not a bug-detection backstop.
const CLOSE_TIMEOUT_MS = 120_000;
// Sticky item "card_status idle" (2026-09-03) — "card_status nunca
// retorna idle, só waiting/running/exited". No PTY output for this long
// reads as "sitting at a prompt, not actively working" — same imprecision
// as `useTerminal.ts`'s own `isActive` (item 6, sticky: can't distinguish
// a long "thinking" pause from real idle without understanding each
// provider's own UI), picked deliberately LONGER than that 900ms client
// heuristic so a normal generation pause doesn't misreport as idle here.
const IDLE_THRESHOLD_MS = 5_000;
// How often the idle-watch poller (below) re-checks every terminal card
// for a running -> idle transition, to notify whoever spawned it.
const IDLE_WATCH_INTERVAL_MS = 2_000;
// Correção 2 (revisão adversarial, 2026-09-09) — "report é edge-triggered,
// dispara uma vez" não é garantia: um card de review pode legitimamente
// reportar várias rodadas do mesmo diff (observado ao vivo nesta sessão,
// 4 rodadas). Sem proteção, um agente numa dessas rodadas rápidas — ou
// preso num loop de retry — martelaria o PTY do spawner com uma linha por
// relatório. Mitigação simples (leading-edge, por card que REPORTA, não
// por spawner): o primeiro `report` de um card sempre notifica na hora;
// qualquer `report` seguinte do MESMO card dentro desta janela é
// suprimido no popup humano — mas NUNCA perdido: o slot do relatório
// (persistido, ver `ReportRow` em store.ts), a `seq` monotônica e a entrega
// ao agente (fila FIFO por PTY) avançam de qualquer forma. 3s é curto o
// bastante pra não atrasar um handoff real (rounds de review, mesmo
// rápidos, são separados por segundos de trabalho de verdade) e longo o
// bastante pra absorver um loop apertado.
const REPORT_NOTIFY_MIN_INTERVAL_MS = 3_000;
// Reading a page's text is exactly as sensitive as a pixel snapshot (an
// already-open page an agent already has a card reference to) — no human
// decision needed, same short backstop-only timeout as snapshot.
const PAGE_TEXT_TIMEOUT_MS = 10_000;
// DESIGN-BACKLOG.md item 58, M1 — same risk class as snapshot/get_page_text
// (an already-open terminal card an agent already has a reference to): no
// human decision needed, just a renderer round-trip to read the live
// xterm.js buffer. Short backstop-only timeout.
const READ_CARD_TIMEOUT_MS = 10_000;
// DESIGN-BACKLOG.md item 58, M4 — default backstop for spawn_agent's
// `wait: true`, when the caller doesn't pass its own `waitTimeoutMs`.
// Unlike every other timeout in this file, waiting for a real agent to
// finish a real task is not a "something's wrong" case — 10 minutes is a
// reasonable default for that, not a bug-detection backstop.
const DEFAULT_WAIT_EXIT_TIMEOUT_MS = 600_000;
// DESIGN-BACKLOG.md item 58, M2 — above a CLI's bracketed-paste threshold,
// a `\r` appended to the same write as the text is swallowed as part of
// the pasted content instead of submitting it. Sending it as a separate
// write, after the target's readline has had a beat to settle, submits
// reliably MOST of the time — but not always. Achado ao vivo (2026-08-30,
// reportado diretamente pelo usuário): under real system load this fixed
// delay is a bet, not a guarantee — it can still fire before the paste
// buffer has actually settled, leaving the Enter swallowed same as
// before the M2 fix. SEND_ENTER_MAX_ATTEMPTS/SEND_ENTER_CONFIRM_DELAY_MS
// below turn this from "hope the delay was enough" into "check, and
// retry the Enter (never the text) if it wasn't".
const SEND_ENTER_DELAY_MS = 80;
// DESIGN-BACKLOG.md item 60-adjacent (send_to_card follow-up) — how long
// to wait after writing `\r` before reading back the card's own text to
// confirm it actually submitted, and how many times to retry just the
// `\r` (never the original text again — resending that would duplicate
// it) if it didn't. Bounded so a card that's genuinely just slow to
// render never gets stuck retrying forever.
const SEND_ENTER_CONFIRM_DELAY_MS = 250;
const SEND_ENTER_MAX_ATTEMPTS = 4;
// DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
// caixa sem submeter" — só o intervalo de poll do portão de prontidão
// (`waitForWriteReadiness` abaixo); os limiares que de fato decidem
// "pronto ou não" (quiescência, teto de segurança) vivem em
// `type-and-submit-decision.ts`, testados puros. Curto de propósito: o
// caso comum (card já pronto há muito tempo) resolve na 1ª checagem, sem
// nenhum `delay` — isto só afeta quantas vezes por segundo um card
// GENUINAMENTE ainda subindo é reconsultado.
const WRITE_READY_POLL_MS = 40;
// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 1 — same
// reasoning as DEFAULT_WAIT_EXIT_TIMEOUT_MS: waiting for a real agent's
// real result is not a bug-detection backstop, it's the actual point.
const DEFAULT_REPORT_TIMEOUT_MS = 600_000;
// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 6 — the
// audit's own "corte mínimo honesto" default, used only when a caller
// doesn't pass its own `cap`. Purely advisory (see `concurrency_status`
// below) — nothing here queues or refuses a spawn.
const DEFAULT_CONCURRENCY_CAP = 3;
// DESIGN-BACKLOG.md item 60, peça 1 — reversal of peça 6's "no queue"
// decision, scoped to autonomous boards only: a spawn_agent that hits the
// board's cap now waits here instead of being refused outright. Long
// default on purpose — the same "waiting for a real result is the actual
// point" reasoning as DEFAULT_REPORT_TIMEOUT_MS above, not a bug backstop.
const DEFAULT_QUEUE_TIMEOUT_MS = 600_000;
// DESIGN-BACKLOG.md item 60, peça 4 — small on purpose: an unattended
// auto-retry loop that never gives up is worse than one that stops and
// leaves a clearly `failed` task for a human/orchestrator to look at.
const DEFAULT_MAX_RETRIES = 2;

// DESIGN-BACKLOG.md item 21, ponto 9, achado 1 — an agent spawning another
// agent, which spawns another... with zero guard, is an unbounded fork
// bomb. `depth` travels with every spawned process's env
// (AGENT_CANVAS_SPAWN_DEPTH, see pty-registry.ts) purely for that
// process's own introspection/display — it increments by 1 on every
// agent-initiated (not human-initiated) spawn, and a human spawning from
// the rail/radial menu always starts a fresh chain at depth 0. Pre-release
// audit S4 — the guard itself no longer trusts a caller-supplied depth
// back; see `cardSpawnDepth` further down for the server-side record it
// actually checks against. This is a hard cap enforced BEFORE any consent
// modal even shows — asking a human to approve something structurally
// disallowed is just noise.
export const MAX_SPAWN_DEPTH = 3;

/** DESIGN-BACKLOG.md §2.1 "effort do card não é persistido" — per-provider
 * ranges re-measured 2026-09-12 against the live CLIs (not the comments):
 *
 * - `claude --help` (v2.1.269): `--effort <level>` is
 *   `low, medium, high, xhigh, max`. An unknown value is NOT rejected —
 *   the CLI prints `Warning: Unknown --effort value '…' — ignoring it and
 *   using the default effort` and continues. That is the same silent-
 *   substitution class this gate exists for, so claude NOW has a list
 *   here (the 2026-09-10 comment that it "accepts anything callers send
 *   it, so there's nothing to refuse" was empirically false).
 * - `agy --help` (v1.2.2): `--effort` is `low|medium|high`. Passing
 *   `xhigh`/`max` fails with `invalid --effort "…" (valid: low, medium,
 *   high)` — confirmed via `agy --effort xhigh --model <fake>
 *   --print='x'`. The older "available: low, high" error (gemini-3.1-pro
 *   without `--effort`, 2026-09-10) is no longer the CLI's range.
 *
 * DECISION (documented here, not just in the session report): a
 * `spawn_agent` whose provider has a known range, with an effort outside
 * that range, is REFUSED (`ok: false`, no card created), never silently
 * remapped to the nearest supported value. Mapping in silence repeats the
 * exact bug class this whole fix exists for — the user asked for X, got
 * Y, and the app never said so ("a sessão era um opus medium... voltei
 * como high e custou muito" was ITSELF a silent substitution, just one
 * the app didn't even choose on purpose). A refusal surfaces immediately,
 * in the same `ok:false` channel every other spawn precondition here
 * already uses (missing provider, spawn depth limit) — the caller sees
 * exactly why, before any process or card is created, and can retry with
 * a value that actually works. The alternative (spawn anyway with the raw
 * value) is worse than either: it would just move the same silent-
 * substitution failure one layer down, into the CLI's own warning/error,
 * where nothing in this app surfaces it as an error at all. */
const CLAUDE_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const ANTIGRAVITY_EFFORT_VALUES = new Set(["low", "medium", "high"]);

/** DESIGN-BACKLOG.md item 21 ponto 9 / achado ao vivo (2026-09-01) —
 * `kind` e `label` são novos. Antes esta lista era filtrada para
 * `kind === "terminal"` lá no `index.ts`, o que deixava um card de
 * navegador (ou sticky, ou arquivos) literalmente inendereçável: o agente
 * precisava do id pra `get_page_text`/`browser_click`/`snapshot`, e o único
 * jeito de descobri-lo era o valor de retorno do `spawn_card` que o
 * criou — inútil pra qualquer card que um humano abriu. `label` entra pelo
 * mesmo motivo do outro achado da mesma sessão: renomear o card ("Stellar")
 * era puramente decorativo porque nada no bus sabia do nome. Com ele aqui,
 * `resolveTargetId` abaixo aceita o rótulo como alvo. */
export type CardSummary = {
  id: string;
  kind: string;
  provider: string;
  cwd: string;
  label: string | null;
  url?: string;
  /** DESIGN-BACKLOG.md §2.1 "identidade e descoberta de card", ponto 1 —
   * o nome que um humano veria no header deste card AGORA, mesmo sem
   * `label`: `label` quando existe, senão a mesma derivação
   * (`deriveCardDisplayName`, shared/card-identity.ts) que o header do
   * card usa. Antes disto, um agente sem `label` só tinha o `id` numérico
   * pra citar o card de volta — reportado ao vivo pelo dono do repo
   * ("estranho... 'card 321'"). Só pra EXIBIÇÃO: o ordinal embutido nele
   * (cards `terminal` sem label) muda se outro card do mesmo provider for
   * fechado — nunca use isto como chave, `id` continua sendo isso. */
  displayName: string;
};
export type SnapshotResult = { ok: true; path: string } | { ok: false; error: string };
export type PageTextResult = { ok: true; text: string; truncated: boolean } | { ok: false; error: string };
export type ReadCardResult = { ok: true; text: string } | { ok: false; error: string };
/** Mesma paleta de `StickyCard.tsx` — duplicada aqui de propósito, não
 * importada: main e renderer são bundles separados neste app Electron
 * (ver AGENTS.md), sem import cross-processo possível. Exportada (não só
 * interna a este arquivo) porque mcp-server.ts, no MESMO processo main,
 * reusa o valor pro enum do zod em `set_sticky_color`. */
export const STICKY_COLORS = ["yellow", "green", "blue", "pink"] as const;

export type StickyResult =
  | { ok: true; content: string }
  | { ok: true; content: string; appended: true; totalLines: number }
  | { ok: true; color: string }
  | { ok: true; mode: "edit" | "preview" }
  | { ok: false; error: string };
/** `requesterId` (2026-09-02) em toda variante que MUTA a nota — nunca em
 * `read` (leitura não conecta card nenhum) — é o que deixa a regra geral
 * de auto-conector (App.tsx's `autoConnect`, chamada do `offSticky`)
 * saber QUEM pediu a mutação, sem precisar de um round-trip extra só pra
 * descobrir isso. */
export type StickyOp =
  | { op: "read" }
  | { op: "write"; content: string; mode: "replace" | "append"; requesterId?: string }
  | { op: "set_color"; color: string; requesterId?: string }
  | { op: "set_mode"; mode: "edit" | "preview"; requesterId?: string };
export type CardStatusResult = { ok: true; status: "running" | "waiting" | "exited" } | { ok: false; error: string };
export type SpawnCardKind = "files" | "changes" | "sticky" | "browser" | "remote-window" | "task";
export type SpawnAgentResult =
  | { ok: true; cardId: string; exited?: boolean; exitCode?: number }
  | { ok: false; error: string };
export type SpawnCardResult = { ok: true; cardId: string } | { ok: false; error: string };

export type BusRequest =
  | { cmd: "list" }
  | { cmd: "send"; target?: string; text?: string; requesterId?: string }
  | { cmd: "open"; url?: string; requesterId?: string; reason?: string }
  | { cmd: "close_card"; target?: string; requesterId?: string; reason?: string }
  | {
      cmd: "snapshot";
      target?: string;
      rect?: { x: number; y: number; w: number; h: number };
    }
  | { cmd: "get_page_text"; target?: string }
  // `ref` (achado ao vivo 2026-09-01): um id vindo do `browser_snapshot`,
  // pra mirar um elemento sem já saber um seletor CSS. Tem precedência
  // sobre `selector`; a tradução ref→seletor vive em index.ts, junto do
  // registry que carimba o atributo, pra não haver dois lugares sabendo o
  // nome dele.
  // `requesterId` (2026-09-02) nos 4 mutantes — regra geral de
  // auto-conector, ver `AUTO_CONNECT_CMDS` abaixo. Ausente em
  // `browser_query` (leitura, nunca conecta nada).
  | { cmd: "browser_click"; target?: string; x?: number; y?: number; selector?: string; ref?: string; requesterId?: string }
  | { cmd: "browser_type"; target?: string; text?: string; selector?: string; ref?: string; requesterId?: string }
  | { cmd: "browser_scroll"; target?: string; dx?: number; dy?: number; selector?: string; ref?: string; requesterId?: string }
  | { cmd: "browser_query"; target?: string; selector?: string; ref?: string }
  | { cmd: "browser_eval"; target?: string; js?: string; requesterId?: string }
  | { cmd: "browser_snapshot"; target?: string }
  | { cmd: "browser_console"; target?: string; level?: string; limit?: number }
  | { cmd: "browser_network"; target?: string; status?: number; failedOnly?: boolean; urlContains?: string; limit?: number }
  | { cmd: "browser_wait_for"; target?: string; selector?: string; text?: string; gone?: boolean; timeoutMs?: number }
  | { cmd: "read_card"; target?: string; lines?: number }
  // Achado ao vivo (2026-09-01): "o send_to_card só escreve em card de
  // terminal — sticky é editável só por você (SEM LEITURA TAMBEM)".
  // Tools próprias em vez de estender send_to_card/read_card: "digitar num
  // terminal e apertar Enter" e "substituir o texto de uma nota" são
  // operações diferentes o suficiente pra que sobrecarregar o mesmo nome
  // só produza erro de uso (não há Enter, não há scrollback, `lines` não
  // significa nada). Decidido com o usuário.
  | { cmd: "read_sticky"; target?: string }
  | { cmd: "write_sticky"; target?: string; content?: string; mode?: string; requesterId?: string }
  // Regra geral de auto-conector (2026-09-02) — controle de cor/categoria
  // e modo edição/preview, mesma identidade de chamador que write_sticky
  // já carrega.
  | { cmd: "set_sticky_color"; target?: string; color?: string; requesterId?: string }
  | { cmd: "set_sticky_mode"; target?: string; mode?: string; requesterId?: string }
  // Pendentes #188 ("delete_card"/"update_card_content") — close_card and
  // write_sticky/read_sticky only ever look at `callbacks.listCards()`,
  // which is scoped to whichever ONE board is currently loaded (every
  // other board's cards only exist as DB rows, no live PTY/DOM at all —
  // see AGENTS.md). These two reach a card on ANY board, loaded or not:
  // for the loaded one they delegate straight to close_card/write_sticky
  // (identical behavior, not a second implementation); for any other
  // board — no live UI to ever show a human a consent modal — they
  // require that board's OWN autonomous flag, same "no human in the
  // loop, but explicitly told this is fine" contract spawn_card/open_url
  // already use.
  | { cmd: "delete_card"; target?: string; requesterId?: string; reason?: string }
  | { cmd: "update_card_content"; target?: string; content?: string; mode?: string; requesterId?: string }
  | { cmd: "card_status"; target?: string }
  /** Prototipo (2026-09-06) — "unificar detecção de turno" pedido pelo
   * usuário: hoje `isActive` (useTerminal.ts) é só uma aproximação por
   * silêncio de bytes (900ms sem nada = "parou"), que faz a barra de
   * atividade sumir mesmo com o agente ainda genuinamente trabalhando
   * (pensando, chamando ferramenta). Sinal real pro provider `claude`:
   * um hook `Stop` (`--settings` efêmero, providers.ts) chama `acbridge
   * turn-complete` exatamente quando o turno acaba de verdade — sem
   * `target`/`requesterId` explícitos porque `acbridge`'s CLI já
   * preenche `cardId` sozinho a partir do próprio `AGENT_CANVAS_CARD_ID`
   * do processo que roda o hook, mesmo padrão de auto-fill de `report`. */
  | { cmd: "turn_complete"; cardId?: string }
  // `verdict` — DESIGN-BACKLOG.md §2.1 decisão 9: campo real e opcional
  // do protocolo (não mais só uma convenção informal dentro do JSON livre
  // de `report`), para não quebrar quem já reporta sem mandar nada.
  | { cmd: "report"; requesterId?: string; report?: unknown; verdict?: "aprovado" | "reprovado" }
  // `afterSeq` — Parte 2b, "quatro rodadas do mesmo diff, a 4a chamada
  // devolvia a 3a instantaneamente": com `wait: true` e `afterSeq` dado,
  // só resolve quando existir um relatório de sequência MAIOR que essa
  // (nunca o que já estava lá). Omitido, comportamento de sempre: devolve
  // o último já presente.
  | { cmd: "get_report"; target?: string; wait?: boolean; timeoutMs?: number; afterSeq?: number }
  | {
      cmd: "create_task";
      prompt?: string;
      provider?: string;
      cardId?: string;
      boardId?: string;
      /** Working directory for auto-dispatch/retry. Omit/`undefined` =
       * task carries `cwd: null` and spawn falls back to the board root
       * (same as before — declared, not inferred from a repo heuristic). */
      cwd?: string;
      deps?: string[];
      maxRetries?: number;
      fallbackProviders?: string[];
      // DESIGN-BACKLOG.md §2.1 decisão 6 — só o palpite do AGENTE. `order`
      // (o humano arrastando) não tem parâmetro em nenhum cmd desta fase
      // — nenhuma UI ainda o escreve, de propósito (ver o relatório
      // final).
      suggestedOrder?: number;
    }
  | {
      cmd: "update_task";
      taskId?: string;
      status?: string;
      cardId?: string | null;
      /** Set/clear the task's own cwd for later auto-dispatch. `null`
       * clears back to board-root fallback; omit leaves unchanged. */
      cwd?: string | null;
      result?: unknown;
      incrementRetry?: boolean;
      attemptedProvider?: string;
      suggestedOrder?: number;
      /** Briefing text. Omitted = leave the stored prompt unchanged.
       * Default write is append (original statement stays); `promptMode:
       * "replace"` is required to overwrite. Does NOT type into a live
       * card — spawn is the only path that delivers `prompt` to a PTY. */
      prompt?: string;
      /** Default `"append"`. `"replace"` is explicit intent only. */
      promptMode?: TaskPromptWriteMode;
      /** DESIGN-BACKLOG.md §2.1 Decisão 8 — quem chamou, pra o aviso de
       * status retido (typeAndSubmit) chegar no PTY certo. Ausente em
       * chamadas antigas / bookkeeping externo: o aviso ainda volta no
       * envelope MCP (`warning`), e cai no `card_id` da task se houver. */
      requesterId?: string;
    }
  // DESIGN-BACKLOG.md §2.1 item 6 — `boardId` opcional: omitido, devolve
  // exatamente a lista sem filtro de sempre (nenhum comportamento
  // existente muda).
  | { cmd: "list_tasks"; boardId?: string }
  | { cmd: "get_task"; taskId?: string }
  | {
      cmd: "request_task_status";
      taskId?: string;
      status?: string;
      reason?: string;
      requesterId?: string;
    }
  // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — fechamento explícito
  // por agente (MCP). Nunca por data. `boardId` obrigatório: sprint é
  // por board, não global.
  | { cmd: "close_sprint"; boardId?: string }
  | { cmd: "open_sprint"; boardId?: string }
  | { cmd: "list_sprints"; boardId?: string }
  | { cmd: "rename_sprint"; sprintId?: string; name?: string | null }
  | { cmd: "delete_sprint"; sprintId?: string }
  | { cmd: "list_connectors" }
  | { cmd: "set_connector_kind"; connectorId?: string; kind?: string | null; requesterId?: string }
  | { cmd: "set_connector_label"; connectorId?: string; label?: string | null }
  | { cmd: "concurrency_status"; cap?: number }
  | { cmd: "board_mode"; target?: string }
  | {
      cmd: "spawn_agent";
      provider?: string;
      cwd?: string;
      resumeId?: string;
      requesterId?: string;
      reason?: string;
      model?: string;
      /** Sticky item "spawn_agent effort" (2026-09-03) — Antigravity needs
       * this alongside `model` (`providers.ts`'s `SpawnOpts.effort`) or it
       * silently falls back to a different model with only a warning, no
       * error. `undefined` for every provider that ignores it.
       *
       * Widened from `"low" | "high"` to plain `string` (DESIGN-BACKLOG.md
       * §2.1, 2026-09-10) — each provider that reads `--effort` has its
       * own range (claude: five values; antigravity: low/medium/high,
       * re-measured 2026-09-12). See `CLAUDE_EFFORT_VALUES` /
       * `ANTIGRAVITY_EFFORT_VALUES` for where an out-of-range value is
       * actually enforced (refused, not silently remapped). */
      effort?: string;
      /** DESIGN-BACKLOG.md item 62 — same free-text label a human sets via
       * CardTag rename; `describeCardLabel`/the renderer's `describeCard`
       * already prefer it over the "Bash 2°" ordinal when present. */
      label?: string;
      wait?: boolean;
      waitTimeoutMs?: number;
    }
  | {
      cmd: "spawn_card";
      kind?: string;
      cwd?: string;
      url?: string;
      requesterId?: string;
      reason?: string;
      /** Pendentes #188 ("spawn_card por coordenadas") — place the new
       * card right next to an existing one instead of `centeredSlot`'s
       * viewport-center placement. `side` defaults to "right" when
       * `anchorCardId` is given without it. */
      anchorCardId?: string;
      side?: "left" | "right" | "top" | "bottom";
    };

export type BusResponse = Record<string, unknown> & { ok: boolean };

/**
 * A local Unix socket bridge letting a spawned provider CLI act on the
 * board via its own shell tool — none of claude/codex/cursor-agent expose
 * any channel for one session to reach another, so `acbridge` (the CLI
 * script this listens for) is the only realistic bridge that works
 * unconditionally across all three vendors. `handleRequest` below is ALSO
 * the backend for `mcp-server.ts` (DESIGN-BACKLOG.md item 21, ponto 9) —
 * one dispatcher, two frontends (a raw JSON-line socket for `acbridge`,
 * an MCP tool call for a provider that speaks MCP), so a consent flow or
 * a new capability is written once and both frontends get it for free.
 */
export function createMessageBus(
  sockPath: string,
  callbacks: {
    listCards: () => CardSummary[];
    writeToCard: (id: string, text: string) => void;
    /** Internal delivery path: the registry records this write as agent
     * delivery rather than human keystrokes, so the delivery itself cannot
     * trip the human-input gate or rearm session discovery. Optional keeps
     * existing test doubles and external integrations source-compatible. */
    writeToCardWithOrigin?: (id: string, text: string, origin: "delivery") => void;
    /** Small critical section around one delivery's text + Enter + check.
     * Human bytes arriving during it are retained by the PTY registry and
     * replayed afterward in order. */
    beginCardDelivery?: (id: string) => boolean;
    /**
     * Closes the delivery critical section and replays any human bytes
     * that arrived while it was held. When those bytes flushed, the
     * return says so — deliverCard then emits `notifyCardInput`, the
     * same notice as a live keystroke. `void` keeps older test doubles
     * source-compatible (no flush signal → no extra notice).
     */
    endCardDelivery?: (id: string) => void | { flushedHumanInput: boolean };
    /** DESIGN-BACKLOG.md item 61 — same "Bash 2°" ordinal-per-provider
     * convention App.tsx's `describeCard` already uses for
     * `AgentAskModal`'s requester label, reimplemented here against
     * `store.ts` directly (this is main-process code, no renderer
     * `cardsRef` to read) so `send_to_card` can prefix delivered text
     * with who sent it — no MCP tool had a caller-identity param at all
     * before this (unlike open_url/spawn_agent/spawn_card, which always
     * did). Falls back to a human-set `label` when the card has one,
     * same priority order as the renderer's version. */
    describeCardLabel: (cardId: string) => string;
    /** `reason` — DESIGN-BACKLOG.md item 21, ponto 9, "motivo" in the
     * generic ask-permission component: only ever set by an MCP tool call
     * (a real, typed, optional param there); acbridge's CLI never sets it
     * (would need an awkward extra positional arg) — the consent modal
     * just shows nothing for that line when absent. */
    onOpenRequest: (requestId: string, requesterId: string, url: string, reason?: string, autoApprove?: boolean) => void;
    /** Sticky item "close_card" (2026-09-03) — same ask/consent/resolve
     * shape as `onOpenRequest` above, generalized to closing ANY existing
     * card (not just terminal — a stuck files/browser/sticky card is just
     * as legitimate a target). `closeCard()`'s own live-terminal
     * "are you sure" gate (App.tsx) is skipped on this path — the human's
     * approval of THIS request already covers it, asking twice would be
     * pure friction. */
    onCloseCardRequest: (requestId: string, requesterId: string, target: string, reason?: string, autoApprove?: boolean) => void;
    /** cardId set: that card's current on-screen rect. rect set: an
     * explicit world-space rect. Neither: the whole window. Resolving
     * either into actual capturePage() screen pixels lives in
     * main/index.ts — this module only relays the parsed request. */
    onSnapshotRequest: (
      requestId: string,
      target: { cardId: string } | { rect: { x: number; y: number; w: number; h: number } } | null,
    ) => void;
    /** Pre-release audit B6 — `onSnapshotRequest`/`onReadCardRequest`
     * below each register their own one-shot `ipcMain` reply listener in
     * main/index.ts, cleaned up when the renderer actually replies. If it
     * never does (unresponsive window), this module's own timeout below
     * resolves the caller anyway — but nothing told main/index.ts to give
     * up too, so its listener stayed registered forever. Called right
     * before resolving on timeout so index.ts can remove its listener for
     * this exact `requestId`. */
    onSnapshotTimeout: (requestId: string) => void;
    /** No consent gate (see PAGE_TEXT_TIMEOUT_MS) — reads an already-open
     * browser card's rendered text, same risk class as `snapshot`. */
    onPageTextRequest: (requestId: string, cardId: string) => void;
    /** DESIGN-BACKLOG.md §2.1 "MCP do Navegador — Orquestração Completa"
     * — the 5 browser control tools, all resolving synchronously (well,
     * async, but 100% local to this process — see the doc comment on
     * `browser_click`'s handler below for why these don't need the
     * pending-map+timeout ceremony `onSnapshotRequest`/`onPageTextRequest`
     * use). Same no-consent-gate reasoning as `onPageTextRequest` — these
     * only act inside a browser card the human already approved creating
     * (`open_url`), never create/navigate anything new themselves.
     * `browserEval` is the one exception worth calling out: it runs
     * arbitrary agent-supplied JS in the page's real context (cookies/
     * session/localStorage reachable) — accepted risk, documented in the
     * MCP tool's own `description` (mcp-server.ts), not hidden here. */
    browserClick: (cardId: string, x?: number, y?: number, selector?: string, ref?: string) => Promise<BusResponse>;
    browserType: (cardId: string, text: string, selector?: string, ref?: string) => Promise<BusResponse>;
    browserScroll: (cardId: string, dx: number, dy: number, selector?: string, ref?: string) => Promise<BusResponse>;
    browserQuery: (cardId: string, selector?: string, ref?: string) => Promise<BusResponse>;
    browserEval: (cardId: string, js: string) => Promise<BusResponse>;
    browserSnapshot: (cardId: string) => Promise<BusResponse>;
    browserConsole: (cardId: string, level?: string, limit?: number) => BusResponse;
    browserNetwork: (cardId: string, opts: { status?: number; failedOnly?: boolean; urlContains?: string; limit?: number }) => BusResponse;
    browserWaitFor: (cardId: string, opts: { selector?: string; text?: string; gone?: boolean; timeoutMs?: number }) => Promise<BusResponse>;

    /** DESIGN-BACKLOG.md item 58, M1 — only the renderer holds the live
     * xterm.js Terminal instance for a terminal card (main never sees
     * terminal content, only raw pty bytes flowing through). */
    onReadCardRequest: (requestId: string, cardId: string, lines?: number) => void;
    /** Mesma forma de request/reply do `onReadCardRequest` acima, e pelo
     * mesmo motivo: o `<textarea>` montado no renderer é a fonte da verdade
     * enquanto o card existe. Ler do SQLite devolveria texto velho no meio
     * de uma digitação (o commit só acontece no blur), e escrever só no
     * SQLite seria sobrescrito pelo próximo commit de digitação. */
    onStickyRequest: (requestId: string, cardId: string, op: StickyOp) => void;
    onStickyTimeout: (requestId: string) => void;
    /** Pre-release audit B6 — same listener-leak-on-timeout fix as
     * `onSnapshotTimeout` above, for `readcard:reply`. */
    onReadCardTimeout: (requestId: string) => void;
    /** Regra geral de auto-conector (2026-09-02) — push fire-and-forget
     * pro renderer (única fonte de verdade do `connectors` visível no
     * board aberto) sempre que uma mutação cross-card identifica quem a
     * pediu. Só o "send" cmd chama isso hoje — write_sticky/
     * set_sticky_color/set_sticky_mode já round-trip pro renderer por
     * outro motivo (o `<textarea>` é a fonte de verdade do conteúdo) e
     * chamam App.tsx's `autoConnect` direto de lá, sem precisar deste
     * push. Dedup/idempotência vivem inteiramente do lado do renderer. */
    onAutoConnect: (fromCardId: string, toCardId: string, kind: string, label?: string | null) => void;
    /** DESIGN-BACKLOG.md item 58, M4 — pty-registry.ts's own `isAlive`,
     * threaded straight through: no round trip needed, main already knows. */
    isCardAlive: (cardId: string) => boolean;
    /** Sticky item "card_status idle" — `null` for a card with no live
     * PTY entry (never spawned/exited/error), matching `isCardAlive`'s
     * own "no entry" convention. */
    getCardLastActivityAt: (cardId: string) => number | null;
    /** DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica
     * na caixa sem submeter" — `typeAndSubmit`'s portão de prontidão
     * (`type-and-submit-decision.ts`'s `decideWriteReadiness`) precisa dos
     * 3 campos juntos pra uma decisão só; `null` com a mesma convenção de
     * `isCardAlive`/`getCardLastActivityAt` (sem entry, nada a esperar). */
    getCardWriteReadiness: (cardId: string) => {
      spawnedAtMs: number;
      hasReceivedData: boolean;
      lastActivityAtMs: number;
      hasPendingHumanInput?: boolean;
      inputLineLastAtMs?: number | null;
      /** Peer requested DECSET 2004h. Absent/false → deliver raw bytes. */
      bracketedPasteMode?: boolean;
    } | null;
    /** Sticky item "card_status idle" (fix ao vivo, 2026-09-04) — OS
     * notification, never touches any terminal's PTY/input. See the doc
     * comment on `notifySpawnerOfIdleCard` above for why `writeToCard`
     * was wrong here. `idleThresholdMs` is passed through purely for the
     * notification body text, not used for any timing decision here. */
    notifyIdleCard: (spawnerId: string, idleCardLabel: string, idleThresholdMs: number) => void;
    /** Achado ao vivo (2026-09-09) — "ja acabou, novamente você não tem
     * informação, precisamos melhorar o report": o `report` cmd só
     * guardava o resultado e resolvia quem já estava esperando com
     * `read_report({wait:true})` — quem não estava esperando (o caso
     * comum: orquestrador seguiu fazendo outra coisa) nunca sabia que
     * chegou. Mesmo canal não-invasivo do `notifyIdleCard` acima (OS
     * `Notification`, nunca o PTY), mas o aviso carrega só o PONTEIRO
     * (label de quem reportou) — nunca o corpo do relatório: um relatório
     * grande despejado ali envenenaria o contexto de quem recebe, e o
     * valor do `report` é justamente ser estruturado, lido sob demanda via
     * `read_report`. */
    notifyCardReported: (spawnerId: string, reportingCardLabel: string) => void;
    /** DESIGN-BACKLOG.md §2.1 "SINAL 2 — saída sem relatório" — a metade
     * humana do mesmo aviso, mesmo canal/postura de `notifyCardReported`
     * acima (popup de SO, nunca o PTY): serve a quem estiver mesmo olhando
     * a tela. A metade que alcança um AGENTE de verdade é a 2ª, feita em
     * `notifySpawnerOfUnreportedExit` via `typeAndSubmit` — mesmo padrão
     * de divisão que o sinal 1 (report) já usa. */
    notifyCardExitedWithoutReport: (spawnerId: string, exitedCardLabel: string, exitCode: number) => void;
    /** Prototipo (2026-09-06) — ver o comentário de `turn_complete` no
     * `BusRequest` acima. Push fire-and-forget pro renderer, keyed pelo
     * mesmo id unificado card/PTY (pty-registry.ts); `useTerminal.ts`
     * escuta e, só pro provider `claude`, usa isto como o sinal
     * DEFINITIVO de fim de turno em vez do timer de silêncio de 900ms. */
    notifyTurnComplete: (cardId: string) => void;
    /**
     * Activity bar (1fcd36b limit): a programmatic delivery just wrote
     * the BODY into this card. Same semantic as a keystroke — the
     * renderer applies `"input"` and opens the turn window. Optional:
     * test doubles stay source-compatible. Must NOT be invoked on
     * retry Enter or composer clear — see `deliveryWriteOpensTurn`.
     */
    notifyCardInput?: (cardId: string) => void;
    /** Bug real relatado (Pop!_OS, 2026-09-09) — `server.on("error")`
     * abaixo só fazia `console.error`: uma falha de bind (2ª instância que
     * já roubou o socket, ver `app.requestSingleInstanceLock()` em
     * index.ts, ou qualquer outra causa) deixava o acbridge indisponível
     * de um jeito 100% invisível pro usuário E pro agente — o próximo
     * sintoma era o Stop hook explodindo com `connect ENOENT` bem depois,
     * sem nenhum sinal no meio. Mesmo padrão fire-and-forget de
     * `notifyTurnComplete` acima: relay simples pro renderer, nenhum
     * estado novo aqui no bus. */
    notifyBusUnavailable: (message: string) => void;
    /** DESIGN-BACKLOG.md item 59 — which board a card lives on, and
     * whether that board's opt-in autonomous mode is on. Only ever read
     * here, never written — the only write path is a human's toggle in
     * the UI (App.tsx's session UI → `setBoardAutonomous`), never an
     * MCP/acbridge cmd (see AGENTS.md's architecture entry). */
    getCardBoardId: (cardId: string) => string | undefined;
    /** Card rows for one board in the store's live-card universe. The
     * archivedAt field remains explicit in the shared guard input so callers
     * that do have historical rows can ignore them rather than treating
     * history as an occupied queue. */
    listCardsForBoard: (boardId: string) => TaskCardGuardCard[];
    isBoardAutonomous: (boardId: string) => boolean;
    /** RODADA 4 (DESIGN-BACKLOG.md §2.3, fechar a classe do board órfão)
     * — `create_task` valida contra isto antes de gravar: um `boardId`
     * que não existe é recusado (erro explícito ao chamador), nunca
     * gravado em silêncio. Mesmo princípio que fechou o bug do `effort`
     * do antigravity — falhar alto é melhor que gravar lixo quieto, e
     * falha silenciosa nesta base já custou dinheiro uma vez. */
    boardExists: (boardId: string) => boolean;
    /** Pendentes #188 ("delete_card"/"update_card_content") — unlike
     * `listCards()` (only the currently loaded board's live cards), this
     * reads straight from the store across EVERY board — the only way to
     * even validate a target that isn't on the loaded board at all. */
    /** `provider` — DESIGN-BACKLOG.md §2.1 "SINAL 2", achado de review
     * adversarial (achado 3): acrescentado a este callback já existente
     * (não um novo) pra `resolveCardExit` conseguir distinguir um card
     * `bash` (que nunca chama `report` — não tem MCP/conceito de
     * relatório, mesma convenção "bash não é agente" de
     * `countRunningAgentsOnBoard`) de um agente de verdade, mesmo quando
     * o card já saiu do board carregado. `null` pros kinds sem provider
     * (files/changes/browser/sticky/etc.) e pra um card sem linha (já
     * coberto pelo `undefined` do retorno inteiro). */
    getAnyCard: (cardId: string) => { boardId: string; kind: string; provider: string | null } | undefined;
    /** Direct store mutation, no live renderer/IPC round-trip at all —
     * dispatchRequest only ever calls these for a card whose board ISN'T
     * the one currently loaded (nothing live to keep in sync there; a
     * loaded-board card goes through close_card/write_sticky's normal
     * live path instead). */
    deleteCardDirect: (cardId: string) => void;
    updateStickyContentDirect: (
      cardId: string,
      content: string,
      mode: "replace" | "append",
    ) => { ok: true; content: string } | { ok: false; error: string };
    /** DESIGN-BACKLOG.md item 60, peça 2 — per-board override of
     * DEFAULT_CONCURRENCY_CAP below. `null`/`undefined` means "use the
     * default", never "zero". */
    getBoardConcurrencyCap: (boardId: string) => number | null | undefined;
    /** DESIGN-BACKLOG.md item 60, peça 1 — pushed to the renderer every
     * time a board's spawn queue changes (enqueue, dequeue, dispatch,
     * timeout) so a live panel can render position/board/provider without
     * polling. `queue` is already in FIFO order — index is position. */
    onQueueChanged: (
      boardId: string,
      queue: Array<{ id: string; requesterId: string; provider: string; reason?: string; requestedAt: number }>,
    ) => void;
    /** Live (isCardAlive-backed) count of non-bash terminal cards on one
     * board — the same "bash isn't an agent" convention as M4/peça 6's
     * concurrency_status, but board-scoped instead of global, since
     * autonomous mode's cap is enforced per board. */
    countRunningAgentsOnBoard: (boardId: string) => number;
    /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 3 — direct
     * pass-through to store.ts (better-sqlite3 is synchronous, no round
     * trip needed here either). */
    listTasks: () => TaskRow[];
    /** DESIGN-BACKLOG.md §2.1 item 6 — board-scoped counterpart to
     * `listTasks` above, backed by `store.listTasksByBoard`
     * (`idx_tasks_board_id`). Lets `list_tasks` (this file) filter by
     * board at the SQLite layer instead of loading the whole table into
     * Node just to `.filter()` it. */
    listTasksByBoard: (boardId: string) => TaskRow[];
    getTask: (id: string) => TaskRow | undefined;
    upsertTask: (task: TaskRow) => StatusWriteDecision;
    /** Third path — park/clear a status ask without touching status.
     * Optional so existing test doubles stay source-compatible. */
    setStatusAsk?: (
      taskId: string,
      ask: { status: string; reason: string | null; requesterId: string | null; at: number } | null,
    ) => { ok: true } | { ok: false; error: string };
    /** DESIGN-BACKLOG.md §2.1 "Historico de sprints" — pass-through pro
     * store (snapshot congelado no close). O renderer usa IPC próprio;
     * estes callbacks existem só pro MCP/acbridge. */
    listSprints: (boardId: string) => import("./store").SprintRow[];
    openSprint: (boardId: string) => { ok: true; sprint: import("./store").SprintRow } | { ok: false; error: string };
    closeSprint: (boardId: string) =>
      | { ok: true; closed: import("./store").SprintRow; opened: import("./store").SprintRow }
      | { ok: false; error: string };
    renameSprint: (
      sprintId: string,
      name: string | null,
    ) => { ok: true; sprint: import("./store").SprintRow } | { ok: false; error: string };
    deleteSprint: (sprintId: string) =>
      | { ok: true; deleted: import("./store").SprintRow; restored: import("./store").SprintRow | null; movedTaskCount: number }
      | { ok: false; error: string };
    /** Notify the Fila card after an MCP close/open so the history panel
     * refreshes. Optional — tests that don't mount a window omit it. */
    onSprintsChanged?: (boardId: string) => void;
    /** Current task_cards links from the card side. This is deliberately
     * separate from `cardWasExpectedToReport`: a secondary reviewer card can
     * close a participation round without being the principal card whose
     * failed delivery deserves a spawner notification. */
    listTaskCardsForCard: (cardId: string) => TaskCardRow[];
    /** DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" — mesmo
     * pass-through direto pro store das 3 linhas acima, mesmo motivo. O
     * cmd `report`/`get_report` (mais abaixo) continua sendo quem faz
     * JSON.stringify/parse do valor do relatório — a mesma divisão de
     * responsabilidade que `serializeTask` já usa pra `result_json`, não
     * uma segunda convenção. Ver o comentário grande de `ReportRow` em
     * store.ts (append-only por `seq`; `getReport` sem `afterSeq` = mais
     * recente; com `afterSeq` = próximo). */
    getReport: (cardId: string, afterSeq?: number) => ReportRow | undefined;
    upsertReport: (row: ReportRow) => void;
    /** DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" —
     * pass-through síncrono pro `store.ts`'s `recordParticipationRound`
     * (ver o comentário grande lá pro modelo completo). Chamado de DOIS
     * lugares neste arquivo, os dois já choke points existentes: o cmd
     * `report` abaixo (toda vez que um card reporta, com ou sem
     * `verdict`) e o ramo "Sinal 2" de `resolveCardExit` (saída sem
     * NUNCA ter chamado `report` — `verdict: null` pela causa oposta).
     * Nenhum terceiro lugar chama isto — não existe tool de MCP nem cmd
     * de bus que escreva aqui além destes dois, por decisão explícita
     * (MCP só leitura para este dado, via `get_task`). */
    recordParticipationRound: (cardId: string, verdict: string | null, at: number) => void;
    /** Seeda `reportSeqCounter` (abaixo) do que já está persistido — sem
     * isto, um restart zeraria o contador e o PRÓXIMO relatório sairia com
     * seq baixa (1, 2, ...) enquanto relatórios de ANTES do restart ainda
     * têm seq alta persistida: o `afterSeq` do `read_report` passaria a
     * mentir (relatório novo com seq menor que um antigo, consumidor pula
     * o novo). `0` numa tabela vazia — primeiro `++reportSeqCounter`
     * continua começando em 1, igual ao contador em memória de sempre. */
    nextReportSeqSeed: () => number;
    /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 4 — data
     * model only: this exposes the connector graph and lets kind be
     * tagged on an existing connector, but nothing in this app dispatches
     * off it. Deciding WHEN a `depends` edge means "go" is left to an
     * external orchestrating agent, driving spawn_agent itself (which
     * still goes through its own human consent gate, same as ever) —
     * see AGENTS.md's positioning entry on this. */
    listAllConnectors: () => ConnectorRow[];
    setConnectorKind: (id: string, kind: string | null) => boolean;
    /** Same contract as setConnectorKind, `label` column instead — backs
     * `set_connector_label` below (2026-09-09, "label em tempo real"). */
    setConnectorLabel: (id: string, label: string | null) => boolean;
    /** Achado 2 (review adversarial, 2026-09-09) — the push below needs
     * the connector's OWN board to let index.ts filter against the
     * currently open one before `safeSend`ing (same idea as `listCards`'s
     * `board_id === activeBoardId` filter there); a connector's two card
     * ids aren't enough on their own without another lookup, and the
     * connector row already carries `board_id` directly. */
    getConnectorBoardId: (id: string) => string | undefined;
    /** Push side of `set_connector_label`: `set_connector_kind` has NO
     * live push today (confirmed while building this — its doc comment
     * above implies parity with the render state, but there just isn't
     * one; an open board only ever sees a `kind` set at creation time via
     * `onAutoConnect`'s own `addConnector`, never a later change made
     * through the cmd). `label` needs to actually update the pill on an
     * OPEN board without reload — that's the whole point of "tempo real"
     * — so this is new plumbing, not a copy of an existing push. Modeled
     * directly on `onAutoConnect`'s shape (id + new value, safeSend to the
     * renderer) since that's the one real precedent for "main pushes a
     * connector change to the renderer" in this codebase.
     * `boardId` (achado 2 above) is the connector's own board, `undefined`
     * only if it vanished between the UPDATE and this lookup — index.ts
     * decides what to do with it (filter against the open board), this
     * cmd handler just always passes it along. */
    onConnectorLabelChanged: (id: string, label: string | null, boardId: string | undefined) => void;
    /** Same push, `kind` instead of `label`. This one closed the gap the
     * comment above used to DESCRIBE and leave open (DESIGN-BACKLOG.md
     * §2.1, "`set_connector_kind` grava no banco e não avisa o board"):
     * `set_connector_kind` persisted and pushed nothing, so an open board
     * only ever showed a `kind` set at creation time via `onAutoConnect`,
     * and a later change through the cmd stayed invisible until reload.
     * Identical shape and identical `boardId` contract to the label push
     * on purpose — the two cmds are siblings on the same row, and having
     * them behave differently is what made the gap easy to miss. */
    onConnectorKindChanged: (id: string, kind: string | null, boardId: string | undefined) => void;
    onSpawnAgentRequest: (
      requestId: string,
      requesterId: string,
      params: {
        provider: string;
        cwd?: string;
        resumeId?: string;
        depth: number;
        reason?: string;
        model?: string;
        /** Sticky item "spawn_agent effort" — see the `spawn_agent` cmd's
         * own field above. Widened from `"low" | "high"`, same reasoning. */
        effort?: string;
        /** DESIGN-BACKLOG.md item 62 — same free-text label CardTag
         * rename sets; `undefined` leaves the new card unlabeled (the
         * ordinal "Bash 2°" convention applies), same as before this
         * item existed. */
        label?: string;
        /** DESIGN-BACKLOG.md item 59 — set only when the requester's own
         * board is in autonomous mode and under its concurrency cap; the
         * renderer creates the card and resolves immediately, with no
         * `AgentAskModal` shown at all. */
        autoApprove?: boolean;
      },
    ) => void;
    onSpawnCardRequest: (
      requestId: string,
      requesterId: string,
      params: {
        kind: SpawnCardKind;
        cwd?: string;
        url?: string;
        reason?: string;
        /** DESIGN-BACKLOG.md item 60, peça 5 — same meaning as
         * spawn_agent's `autoApprove` above, extended to non-terminal
         * cards. True for the requester's own autonomous board (no
         * concurrency cap applies here, only spawn_agent counts against
         * it) — OR, achado ao vivo 2026-09-06, for `kind: "sticky"`
         * regardless of autonomous mode: same risk class as
         * `write_sticky` (already gate-free), reversible, no disk/process
         * side effect, unlike every other `spawn_card` kind. */
        autoApprove?: boolean;
        /** Pendentes #188 ("spawn_card por coordenadas") — already
         * validated against `callbacks.listCards()` by the time this
         * fires, so the renderer can trust it names a real live card. */
        anchorCardId?: string;
        side?: "left" | "right" | "top" | "bottom";
      },
    ) => void;
  },
) {
  // Bug real relatado (Pop!_OS, 2026-09-09; achado seguinte do coordenador,
  // mesmo dia) — este bloco fazia `unlinkSync(sockPath)` INCONDICIONAL
  // aqui na entrada, antes de sequer tentar bindar. Com o lock de instância
  // única em index.ts gated em `app.isPackaged` (proteger só o app
  // instalado sem quebrar o fluxo de dev — ver o comentário lá), o cenário
  // real é: o Stellar EMPACOTADO está aberto e escutando; o dev roda
  // `electron-vite dev`, que não pega lock nenhum; o dev chega aqui e
  // apaga o `.sock` da instância empacotada VIVA só porque o arquivo
  // existia, binda o seu; quando o dev fecha, `close()` vê (corretamente)
  // que o socket é dele e remove — sobra a instância empacotada viva e
  // ZERO `.sock` no filesystem. É o bug original inteiro, reproduzido pelo
  // próprio fluxo de dev que o gate `isPackaged` foi feito pra proteger.
  //
  // A remoção agora só acontece DEPOIS de provar que não tem ninguém do
  // outro lado — dentro do `server.on("error")` abaixo. `server.listen`
  // roda direto aqui, sem tocar no filesystem antes.
  //
  // Achado ao vivo (2026-09-01, relato de um agente): `open_url` devolvia
  // só `{ok:true}` e nunca o id do card que acabou de abrir, então não
  // havia caminho nenhum do `open_url` pro `browser_click`/`get_page_text`
  // daquele mesmo card — o agente acabou sondando ids numéricos em
  // sequência (121 a 155) até achar. O renderer SEMPRE soube o id
  // (`openBrowserFor` já o retornava, e o `spawn_card` de navegador já o
  // reportava); ele só era descartado no caminho de volta do `open`. O
  // `cardId` aqui é o que fecha essa lacuna.
  const pendingOpens = new Map<string, { resolve: (allowed: boolean, cardId?: string) => void; timer: NodeJS.Timeout }>();
  const pendingCloseCards = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();
  const pendingSnapshots = new Map<string, { resolve: (result: SnapshotResult) => void; timer: NodeJS.Timeout }>();
  const pendingPageTexts = new Map<string, { resolve: (result: PageTextResult) => void; timer: NodeJS.Timeout }>();
  const pendingReadCards = new Map<string, { resolve: (result: ReadCardResult) => void; timer: NodeJS.Timeout }>();
  const pendingStickyOps = new Map<string, { resolve: (result: StickyResult) => void; timer: NodeJS.Timeout }>();
  // DESIGN-BACKLOG.md item 58, M4 — waiters for `spawn_agent`'s
  // `wait: true`, keyed by the spawned card's id. Several waiters could in
  // principle exist for the same card (two callers both waiting on it),
  // so each entry is a list, not a single resolver.
  const pendingCardExits = new Map<string, Array<(exitCode: number) => void>>();
  // Pre-release audit S4 — `req.depth` used to be trusted straight from
  // the CLIENT (an MCP/acbridge caller could just re-declare `depth: 0`
  // on every call and the fork-bomb guard below would never fire). The
  // main process already knows each card's real depth — it's the one
  // that set AGENT_CANVAS_SPAWN_DEPTH in that card's own env when IT was
  // spawned (pty-registry.ts) — so this map is the server-side record,
  // keyed by cardId, that the client can no longer talk its way around.
  // A card absent from this map (human-initiated, or the task engine's
  // own internal dispatch — see onTaskDone/retryOrFail) is depth 0.
  const cardSpawnDepth = new Map<string, number>();
  // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 1 — a
  // dedicated result channel, decoupled from process exit (an agent might
  // report a result and keep running, e.g. an interactive session): the
  // last report a card sent (for a caller polling after the fact) plus
  // waiters for one still pending (same shape as pendingCardExits above).
  /** Parte 2b (achado ao vivo, depois do briefing inicial) — "um card de
   * review que revisou 4 rodadas do mesmo diff devolveu o relatório da 3a
   * rodada instantaneamente na 4a chamada": o protocolo precisa distinguir
   * "relatório novo" de "o mesmo de sempre". `seq` é atribuída AQUI, pelo
   * bus, nunca aceita do chamador — monotônica por processo, seedada do
   * persistido. A tabela `reports` é append-only por `seq` (store.ts);
   * `get_report` sem `afterSeq` devolve o mais recente, com `afterSeq` o
   * próximo — quem lê rodada a rodada não perde conteúdo quando o card
   * reporta de novo.
   *
   * DESIGN-BACKLOG.md §2.1 "cardReports vive só em memória" (achado ao
   * vivo, 2026-09-09) — o `Map` que vivia aqui (`cardReports`) e o
   * contador acima eram 100% em memória: um restart do Electron apagava
   * TODOS os relatórios. Persistência via `callbacks.getReport`/
   * `upsertReport`. `reportSeqCounter` continua em memória, SEEDADO do
   * que já está persistido (`nextReportSeqSeed()`). */
  let reportSeqCounter = callbacks.nextReportSeqSeed();
  type StoredReport = { report: unknown; seq: number; verdict?: string | null };
  const pendingReportWaiters = new Map<string, Array<{ afterSeq: number; resolve: (stored: StoredReport) => void }>>();
  const pendingSpawnAgents = new Map<string, { resolve: (result: SpawnAgentResult) => void; timer: NodeJS.Timeout }>();
  const pendingSpawnCards = new Map<string, { resolve: (result: SpawnCardResult) => void; timer: NodeJS.Timeout }>();
  // DESIGN-BACKLOG.md item 60, peça 1 — one FIFO queue per autonomous
  // board. `params` is exactly what `onSpawnAgentRequest` needs, captured
  // here so the entry can be dispatched later with no information lost.
  type SpawnQueueEntry = {
    id: string;
    requesterId: string;
    provider: string;
    reason?: string;
    requestedAt: number;
    timer: NodeJS.Timeout;
    resolve: (result: SpawnAgentResult) => void;
    params: {
      provider: string;
      cwd?: string;
      resumeId?: string;
      depth: number;
      reason?: string;
      model?: string;
      effort?: string;
      label?: string;
    };
  };
  const spawnQueue = new Map<string, SpawnQueueEntry[]>();
  // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 2 — a card
  // blocked on a consent modal (open/spawn_agent/spawn_card) looks
  // identical to one still working, from the outside. Ref-counted (not a
  // Set) since the same requester could in principle have more than one
  // consent gate open at once. Cleared on resolve AND on the request's own
  // timeout — never left stuck past whichever comes first.
  const waitingOnConsent = new Map<string, number>();
  /** Every programmatic message to one PTY shares one FIFO. Reports, task
   * notices, and explicit `send_to_card` calls must not overtake each other,
   * and none may be dropped just because another delivery is in flight. */
  const deliveryQueues = new Map<string, Promise<void>>();
  function markWaiting(requesterId: string) {
    if (!requesterId) return;
    waitingOnConsent.set(requesterId, (waitingOnConsent.get(requesterId) ?? 0) + 1);
  }
  function unmarkWaiting(requesterId: string) {
    if (!requesterId) return;
    const n = (waitingOnConsent.get(requesterId) ?? 1) - 1;
    if (n <= 0) waitingOnConsent.delete(requesterId);
    else waitingOnConsent.set(requesterId, n);
  }

  // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 3 — the
  // stored row keeps deps/result as opaque JSON text (same convention as
  // cards.messages_json); this is the one place that turns it back into
  // real values for a caller.
  function serializeTask(row: TaskRow) {
    return {
      id: row.id,
      prompt: row.prompt,
      provider: row.provider,
      status: row.status,
      cardId: row.card_id,
      boardId: row.board_id,
      cwd: row.cwd,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      deps: row.deps_json ? JSON.parse(row.deps_json) : [],
      retryCount: row.retry_count,
      attemptedProviders: row.attempted_providers_json ? JSON.parse(row.attempted_providers_json) : [],
      // DESIGN-BACKLOG.md item 60, peça 4 — EFFECTIVE value, same
      // "never null, resolve the fallback here" convention as
      // board_mode's concurrencyCap.
      maxRetries: row.max_retries ?? DEFAULT_MAX_RETRIES,
      fallbackProviders: row.fallback_providers_json ? JSON.parse(row.fallback_providers_json) : [],
      order: row.order,
      suggestedOrder: row.suggested_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // DESIGN-BACKLOG.md §2.1 Decisão 8 — sinal vivo (não histórico).
      // Presente em list/get pra o agente ver a mesma divergência que o
      // quadro Fila mostra.
      divergedStatus: row.diverged_status,
      divergedActor: row.diverged_actor,
      requestedStatus: row.requested_status ?? null,
      requestedReason: row.requested_reason ?? null,
      requestedBy: row.requested_by ?? null,
      requestedAt: row.requested_at ?? null,
      // DESIGN-BACKLOG.md §2.1 "Historico de sprints" — membership vivo.
      sprintId: row.sprint_id ?? null,
      // DESIGN-BACKLOG.md §2.1 "no get_task, por exemplo" — só presentes
      // quando `row` veio de `callbacks.getTask` (que os anexa); ausentes
      // (undefined, somem do JSON) numa linha de `listTasks`, de
      // propósito, pra manter a listagem em massa barata.
      transitions: row.transitions?.map((t) => ({
        kind: t.kind,
        from: t.from_value,
        to: t.to_value,
        actor: t.actor,
        cardId: t.card_id,
        at: t.at,
      })),
      cards: row.cards?.map((c) => ({ cardId: c.card_id, role: c.role })),
      // DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação"
      // — mesma condição de presença que `transitions`/`cards` acima:
      // só existe quando `row` veio de `getTask`, e é SÓ LEITURA por
      // aqui (nenhum cmd deste arquivo escreve verdict/rodada a partir
      // do que um chamador manda de volta — a escrita mora só em
      // `recordParticipationRound`, chamada pelos dois choke points).
      verdicts: row.verdicts?.map((v) => ({ cardId: v.card_id, role: v.role, verdict: v.verdict, at: v.at })),
    };
  }

  function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** DESIGN-BACKLOG.md item 58, M1 — factored out of the `read_card` cmd
   * handler so `send`'s self-verifying submit (below) can reuse the exact
   * same round-trip instead of a second, divergent implementation. */
  function readCardText(target: string, lines?: number): Promise<ReadCardResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingReadCards.delete(requestId);
        callbacks.onReadCardTimeout(requestId);
        resolve({ ok: false, error: "timed out reading card" });
      }, READ_CARD_TIMEOUT_MS);
      pendingReadCards.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          pendingReadCards.delete(requestId);
          resolve(result);
        },
        timer,
      });
      callbacks.onReadCardRequest(requestId, target, lines);
    });
  }

  /** DESIGN-BACKLOG.md §0 "Texto entregue a um card recem-spawnado fica na
   * caixa sem submeter" — portão de prontidão antes de digitar QUALQUER
   * coisa. Poll síncrono e barato (`callbacks.getCardWriteReadiness`, sem
   * round-trip pro renderer) em volta da decisão pura
   * `decideWriteReadiness` (type-and-submit-decision.ts) — ver o doc
   * comment daquele arquivo pra por que os dois achados (portão +
   * confirmação tri-state, em `typeAndSubmit` abaixo) precisam andar
   * juntos. Card sem entry (já morto, ou nunca existiu) devolve
   * imediatamente: nada a esperar, `writeToCard`/o resto do fluxo já
   * lidam com card morto do jeito de sempre. */
  async function waitForWriteReadiness(target: string): Promise<void> {
    for (;;) {
      const snapshot = callbacks.getCardWriteReadiness(target);
      if (!snapshot) return;
      const now = Date.now();
      const decision = decideWriteReadiness({
        hasReceivedData: snapshot.hasReceivedData,
        msSinceLastActivity: now - snapshot.lastActivityAtMs,
        msSinceSpawn: now - snapshot.spawnedAtMs,
      });
      if (decision.action === "proceed") return;
      await delay(WRITE_READY_POLL_MS);
    }
  }

  /** A live PTY can be ready while its human is midway through a line. The
   * registry exposes that cheap signal without exposing terminal contents;
   * wait until the line is submitted or idle since the last human keystroke
   * exceeds the bounded expiry. The latter deliberately lets the queued
   * notice through so delivery is never lost, while the registry keeps the
   * human bytes intact. */
  async function waitForHumanInputGate(target: string): Promise<void> {
    for (;;) {
      const snapshot = callbacks.getCardWriteReadiness(target);
      if (!snapshot) return;
      const decision = decideDeliveryGate({
        hasPendingHumanInput: snapshot.hasPendingHumanInput === true,
        pendingHumanInputLastAtMs: snapshot.inputLineLastAtMs ?? null,
        nowMs: Date.now(),
      });
      if (decision.action === "proceed") return;
      await delay(WRITE_READY_POLL_MS);
    }
  }

  /** Extraído do cmd `send` (correção pós-revisão, 2026-09-09) — ANTES
   * disto `notifySpawnerOfReport` escrevia sua linha via `writeToCard` e
   * parava aí, sem apertar Enter, achando (errado — apontado em revisão)
   * que não submeter era mais seguro. É o oposto: `writeToCard` termina em
   * `entry.proc.write(data)` no PTY (pty-registry.ts) — é digitação
   * simulada, não uma mensagem de canal programático. Texto NÃO submetido
   * fica pendurado no buffer de input de quem estiver do outro lado e é
   * concatenado (ou pior, executado) junto da PRÓXIMA coisa que esse
   * card digitar — exatamente o dano que se queria evitar. `send_to_card`
   * já resolve isso corretamente pra mensagem agente-pra-agente: escreve o
   * texto, aperta Enter, e CONFIRMA que submeteu de verdade (relendo o
   * card e comparando com um prefixo do que foi escrito), retentando só o
   * Enter (nunca o texto de novo) até `SEND_ENTER_MAX_ATTEMPTS`. Extraído
   * aqui pra `send` e `notifySpawnerOfReport` usarem o MESMO mecanismo —
   * nunca uma segunda variante que "quase" faz a mesma coisa.
   *
   * DESIGN-BACKLOG.md §0 (2026-09-11, relatado 2x com `codex`) — 2 achados
   * que se somavam: (1) nada aqui esperava a TUI do CLI terminar de subir
   * antes de digitar (corrigido acima, `waitForWriteReadiness`); (2) a
   * confirmação (antiga `looksUnsent`, booleana) tratava "prefixo ausente
   * da tela" como "enviado", sem distinguir de "tela ainda não desenhou
   * nada" — durante o boot lento do `codex` isso derrubava o laço inteiro
   * na 1ª tentativa, exatamente no caso que mais precisava das outras 3.
   * `decideSubmitCheck` (type-and-submit-decision.ts) resolve isso com um
   * terceiro estado ("unknown"), gated por `hasNewActivitySinceWrite` —
   * `activityAtWrite` abaixo é o baseline ANTES da escrita (sinal de
   * silêncio de boot apenas). Eco vs resposta real NÃO usam esse
   * timestamp: a distinção é por conteúdo (`looksLikeSubmitStarted`).
   * Entrega que desiste limpa o composer (`composerClearSequence`). */
  async function deliverCard(target: string, text: string): Promise<void> {
    await waitForWriteReadiness(target);
    await waitForHumanInputGate(target);

    let deliveryStarted = false;
    const hasDeliverySection = Object.prototype.hasOwnProperty.call(callbacks, "beginCardDelivery");
    if (hasDeliverySection && callbacks.beginCardDelivery) {
      while (!deliveryStarted) {
        if (!callbacks.isCardAlive(target)) return;
        const result = callbacks.beginCardDelivery(target);
        // Existing unit-test doubles use a Proxy that returns a no-op
        // function for unknown callbacks. `undefined` therefore means the
        // optional production hook is absent, not "delivery is busy".
        if (typeof result !== "boolean") break;
        deliveryStarted = result;
        if (!deliveryStarted) await delay(WRITE_READY_POLL_MS);
      }
    }

    const writeDelivery = (data: string, kind: DeliveryWriteKind) => {
      if (Object.prototype.hasOwnProperty.call(callbacks, "writeToCardWithOrigin") && callbacks.writeToCardWithOrigin) {
        callbacks.writeToCardWithOrigin(target, data, "delivery");
      }
      else callbacks.writeToCard(target, data);
      // Body only — retry Enter / composer clear share this write path
      // but must not reopen the turn window (1fcd36b). Not
      // `pty-registry.write` (too low: every delivery byte) and not
      // `typeAndSubmit` (too early/late: the FIFO, not the body).
      if (deliveryWriteOpensTurn(kind)) callbacks.notifyCardInput?.(target);
    };

    try {
      // Screen + activity baselines BEFORE the write. Content signals
      // (Working / follow-ups) only count when a match's neighborhood is
      // new vs screenTextBeforeWrite — leftover prose/chrome from the
      // prior turn must not mark a swallowed Enter as "sent", and a
      // sliding 8-line window that swaps one Working for another must
      // not flatten the delta into a false "unsent".
      const activityAtWrite = callbacks.getCardLastActivityAt(target);
      const beforeSnap = await readCardText(target, 8);
      const screenTextBeforeWrite = beforeSnap.ok ? beforeSnap.text : "";
      // Bracketed Paste only when the peer requested DECSET 2004h
      // (tracked on the PTY stream). Blind CSI 200~/201~ poisons CLIs
      // that never asked — they echo the escapes as text. Short notices
      // stay raw regardless (see shouldUseBracketedPaste).
      const readinessForPaste = callbacks.getCardWriteReadiness(target);
      const bracketedPasteMode = readinessForPaste?.bracketedPasteMode === true;
      writeDelivery(deliveryTextBytes(text, bracketedPasteMode), "body");
      // Sticky item "send_to_card não confirma envio" (2026-09-03) — a
      // regex de placeholder sozinha só cobre UM sintoma (CLI que colapsa
      // um paste grande num chip "[Pasted text ...]"); uma mensagem curta
      // simplesmente fica CRUA na caixa, nunca colapsa, então checar só o
      // placeholder deixaria passar como "enviado" um caso que não foi.
      // Needle: full trimmed text when short (<8 — system notices), else
      // a 24-char prefix. Short needles are matched in the screen tail
      // only (see needleVisibleOnScreen).
      const normalized = text.trim().replace(/\s+/g, " ");
      const sentNeedle = normalized.length < 8 ? normalized : normalized.slice(0, 24);
      // Previous confirm result drives whether the NEXT iteration presses
      // Enter. `null` before attempt 0 → always press once. `"unknown"`
      // never presses (wait/re-read only).
      let previousResult: ReturnType<typeof decideSubmitCheck> | null = null;
      for (let attempt = 0; attempt < SEND_ENTER_MAX_ATTEMPTS; attempt++) {
        await delay(SEND_ENTER_DELAY_MS);
        if (shouldPressEnterOnAttempt(attempt, previousResult)) {
          writeDelivery("\r", "enter");
        }
        await delay(SEND_ENTER_CONFIRM_DELAY_MS);
        const check = await readCardText(target, 8);
        // Falha de leitura (timeout, card sumiu) não é evidência de que o
        // submit falhou — para de retentar em vez de adivinhar. Único
        // `break` fora da decisão pura — inalterado, não regride.
        if (!check.ok) break;
        const currentActivity = callbacks.getCardLastActivityAt(target);
        previousResult = decideSubmitCheck({
          screenText: check.text,
          screenTextBeforeWrite,
          sentNeedle,
          // Timestamp ausente tratado como "houve atividade" de propósito —
          // não travar o laço num "unknown" eterno por timestamp ausente.
          hasNewActivitySinceWrite:
            typeof activityAtWrite !== "number" || typeof currentActivity !== "number" || currentActivity > activityAtWrite,
        });
        if (previousResult === "sent") break;
        // "unsent" → next iteration presses Enter again.
        // "unknown" → next iteration waits/re-reads only (no Enter).
      }
      // Achado 4 — delivery that gave up must not leave text in the
      // composer for the next delivery to concatenate with. Ctrl+U×2.
      if (previousResult !== "sent") {
        writeDelivery(composerClearSequence(), "composer_clear");
      }
    } finally {
      if (deliveryStarted) {
        const ended = callbacks.endCardDelivery?.(target);
        // Deferred human keys are still human. The previous turn may
        // already have closed; without this notice the flush lands as
        // bare PTY bytes, echo arrives as `"data"`, and the bar stays
        // off while the shell works. Body notify already fired above —
        // this is a different turn, the one the human typed.
        if (ended && typeof ended === "object" && ended.flushedHumanInput) {
          callbacks.notifyCardInput?.(target);
        }
      }
    }
  }

  /** Queue all programmatic deliveries per PTY. A rejected delivery does
   * not poison the next one; the next message still gets its own attempt. */
  async function typeAndSubmit(target: string, text: string): Promise<void> {
    const previous = deliveryQueues.get(target) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => deliverCard(target, text));
    deliveryQueues.set(target, current);
    try {
      await current;
    } finally {
      if (deliveryQueues.get(target) === current) deliveryQueues.delete(target);
    }
  }

  /** Round-trip de sticky — mesmo timeout e mesma forma do `readCardText`
   * acima, um helper só pras duas operações porque só o `op` muda. */
  function stickyOp(target: string, op: StickyOp): Promise<StickyResult> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingStickyOps.delete(requestId);
        callbacks.onStickyTimeout(requestId);
        resolve({ ok: false, error: `timed out on sticky ${op.op}` });
      }, READ_CARD_TIMEOUT_MS);
      pendingStickyOps.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          pendingStickyOps.delete(requestId);
          resolve(result);
        },
        timer,
      });
      callbacks.onStickyRequest(requestId, target, op);
    });
  }

  /** Só os cards que têm um PTY vivo por trás — o subconjunto que
   * `writeToCard`/`readCardText`/`isCardAlive` sabem operar. `listCards()`
   * passou a devolver TODOS os cards (ver `CardSummary`), então cada
   * validação que realmente exige um terminal filtra aqui em vez de
   * confiar no filtro que antes acontecia no `index.ts`. */
  function listTerminalCards(): CardSummary[] {
    return callbacks.listCards().filter((c) => c.kind === "terminal");
  }

  /** Sticky item "card_status idle" — `false` for a card with no PTY
   * entry at all (never spawned/already exited) — that's `isCardAlive`'s
   * job to report, not this one's; callers only ask this once they've
   * already confirmed the card is alive. */
  function isCardIdle(cardId: string): boolean {
    const lastActivityAt = callbacks.getCardLastActivityAt(cardId);
    if (lastActivityAt === null) return false;
    return Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS;
  }

  /** Sticky item "card_status idle" — "o agente precisa saber que o card
   * que ele spawnou ficou ocioso... um evento tipo card_status_changed
   * que dispare notificação automática pro agente que fez o spawn_agent".
   *
   * Achado ao vivo (2026-09-04) — a primeira versão disto reusava
   * `writeToCard` (o mecanismo do `send_to_card`), digitando um texto de
   * sistema direto no PTY do spawner. Isso é invasivo por construção:
   * `writeToCard` simula teclas reais, sem apertar Enter — o texto fica
   * sentado, NÃO ENVIADO, dentro do prompt de quem quer que esteja do
   * outro lado. Quando o spawner é o próprio card de chat ao vivo do
   * usuário (o caso comum quando o usuário está orquestrando sub-agentes
   * na mesma sessão em que está digitando), isso invade literalmente a
   * entrada dele — relatado ao vivo como "extremamente invasiva". Trocado
   * por uma notificação de SO (`Notification.notifyIdleCard`, main
   * process), o mesmo canal não-intrusivo já revisado e aprovado nesta
   * sessão pro "turno terminado" — nunca toca o buffer/entrada de
   * nenhum terminal. Um agente orquestrador que precise saber
   * programaticamente ainda tem `card_status` pra fazer poll (o próprio
   * padrão usado ao longo desta sessão). Silent no-op se o spawner sumiu
   * ou não há spawner registrado (card aberto por um humano, não por
   * outro agente). */
  /** Extraído de `notifySpawnerOfIdleCard` (2026-09-09) pro `report` reusar
   * a mesma resolução de linhagem — achar QUEM spawnou `cardId` (conector
   * `kind === "spawned"` mais recente por `updated_at`) e devolver seu id
   * só se ele ainda estiver vivo. `null` cobre os dois no-ops silenciosos
   * que os dois avisos precisam ter: sem conector de spawn (card aberto
   * por um humano) e spawner já morto — nenhum dos dois é erro, os dois
   * só significam "ninguém pra avisar". */
  function resolveLiveSpawner(cardId: string): string | null {
    const spawnedBy = callbacks
      .listAllConnectors()
      .filter((c) => c.kind === "spawned" && c.to_card_id === cardId)
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    if (!spawnedBy) return null;
    const spawnerId = spawnedBy.from_card_id;
    if (!callbacks.isCardAlive(spawnerId)) return null;
    return spawnerId;
  }

  /** DESIGN-BACKLOG.md §0 "Push de report se perde em silencio quando o
   * orquestrador READOTA um card" + "Relatorio nao chega ao orquestrador
   * depois de um restart" — a linhagem `spawned` sozinha (acima) fica
   * cega assim que um card é readotado (briefado via `send_to_card` em
   * vez de `spawn_agent`): nunca existiu conector `spawned` pra ele. A
   * 2ª fonte fecha esse buraco lendo o conector `kind === "modified"`
   * que `AUTO_CONNECT_CMDS` já grava no SQLite em todo `send` bem-
   * sucedido (`pickLatestDirectiveSender` em report-notify-routing.ts) —
   * a mesma tabela, o mesmo `updated_at`, sem um Map em memória do
   * processo que nascia vazio depois de um restart (RODADA 3: report
   * gravado, `targetId` null, ninguém avisado). Não promove `modified`
   * a linhagem: a aresta continua decorativa/auto-connect no grafo; só
   * passa a ser consultada como FALLBACK de rota.
   *
   * Precedência entre as duas fontes (`decideReportNotifyTarget`,
   * report-notify-routing.ts, ver o comentário de topo daquele arquivo pra
   * a rodada 2 completa) — **linhagem de spawn viva ganha sempre**,
   * diretiva é só FALLBACK pra quando não há spawner vivo registrado.
   * Invertido na revisão adversarial desta tarefa: a versão anterior dava
   * preferência cega à diretiva mais recente, o que abre sequestro de
   * notificação num board multi-agente — card A spawna W, card B qualquer
   * manda uma mensagem pra W a meio do trabalho (uso normal, não abuso),
   * e o report de W ia pra B, nunca pra A, que segue vivo esperando. A
   * linhagem de spawn, quando existe e está viva, é sempre o sinal mais
   * confiável de quem quer o report — o caso que motivou a readoção
   * nunca dependia de derrubar isso: o que faltava era o CONECTOR
   * `spawned` em si (ausência), não a vivacidade do orquestrador — então
   * `spawnedById` cai pra `null` (não "presente mas morto") e a
   * resolução cai pro fallback de diretiva de qualquer jeito. Várias
   * arestas `modified` pro mesmo alvo: a de maior `updated_at` ganha
   * (espelha `resolveLiveSpawner` e o "último que mandou" do Map antigo).
   * O caso comum (spawn, card reporta, nenhuma diretiva no meio) nunca
   * acha `modified` inbound — cai direto na linhagem de spawn. */
  function resolveNotifyTarget(cardId: string): string | null {
    const connectors = callbacks.listAllConnectors();
    const spawnedById = resolveLiveSpawner(cardId);
    const directiveFromId = pickLatestDirectiveSender(connectors, cardId);
    return decideReportNotifyTarget({
      directiveFromId,
      directiveFromAlive: directiveFromId !== null && callbacks.isCardAlive(directiveFromId),
      spawnedById,
      spawnedByAlive: spawnedById !== null,
    }).targetId;
  }

  function notifySpawnerOfIdleCard(cardId: string) {
    // Mesma resolução de 2 fontes do report (ver `resolveNotifyTarget`
    // acima) — um card readotado também precisa avisar quem o briefou por
    // último quando fica ocioso, não só quem o spawnou originalmente.
    const spawnerId = resolveNotifyTarget(cardId);
    if (!spawnerId) return;
    const label = callbacks.describeCardLabel(cardId);
    callbacks.notifyIdleCard(spawnerId, label, IDLE_THRESHOLD_MS);
  }

  // Correção 2 (revisão adversarial, 2026-09-09) — ver o comentário de
  // `REPORT_NOTIFY_MIN_INTERVAL_MS` acima. Chave é o card que REPORTA
  // (quem pode estar num loop de rodadas), não o spawner — dois cards
  // diferentes reportando pro mesmo spawner não devem se suprimir um ao
  // outro.
  const lastReportNotifyAt = new Map<string, number>();

  /** Parte 2 do achado "precisamos melhorar o report" (ver o comentário de
   * `notifyCardReported` no tipo `Callbacks` acima) — mesmo caminho do
   * idle: resolve pra quem empurrar (`resolveNotifyTarget`, diretiva mais
   * recente ou conector de spawn, ambos já checados vivos), avisa só com o
   * PONTEIRO (label). Chamado pelo cmd `report` abaixo, nunca aqui
   * mesmo sozinho.
   *
   * Canal 2 — histórico da correção (revisão adversarial, 2026-09-09,
   * DUAS rodadas): a 1ª versão só tinha o popup de SO (canal 1 abaixo),
   * que a Parte 1 desta investigação provou ser invisível pra um agente
   * rodando dentro de um PTY — resolvia a linhagem toda e jogava o aviso
   * fora pro mesmo buraco. A 2ª versão acrescentou `writeToCard` mas SEM
   * apertar Enter, no raciocínio (equivocado, apontado na revisão
   * seguinte) de que não submeter seria "menos invasivo" — na prática é o
   * oposto: `writeToCard` termina em `entry.proc.write(data)` no PTY
   * (pty-registry.ts), digitação simulada de verdade, e texto NÃO
   * submetido fica pendurado no buffer de input do spawner até ser
   * concatenado (ou executado) junto da PRÓXIMA coisa que ele digitar —
   * corrompendo o comando dele. Esta versão usa `typeAndSubmit` (extraído
   * do cmd `send` acima) — o MESMO mecanismo que já entrega mensagem de
   * agente pra agente nesta app, texto + Enter + confirmação — em vez de
   * uma 3ª variante inventada.
   *
   * Por que isto NÃO reabre a objeção de 2026-09-04 contra escrever no
   * PTY (comentário de `notifySpawnerOfIdleCard` acima): aquela troca foi
   * motivada por IDLE ser LEVEL-TRIGGERED — enquanto o card continuasse
   * ocioso, cada tick do poll (a cada 2s) reinseriria a mesma linha,
   * ruído recorrente capaz de destruir uma mensagem longa que um humano
   * estivesse digitando. `report` não tem essa recorrência automática —
   * só dispara quando o card de fato chama `report` — mas TAMBÉM não é
   * garantidamente "uma vez só" (achado da revisão seguinte: um reviewer
   * pode legitimamente reportar várias rodadas seguidas), daí
   * `REPORT_NOTIFY_MIN_INTERVAL_MS` abaixo: throttle explícito em vez de
   * uma suposição de raridade. O cenário concreto que a nota de
   * 2026-09-04 chamava de "extremamente invasivo" — o spawner ser o card
   * de CHAT ao vivo do usuário (`ChatCardData`, card-types.ts, que fala
   * direto com a API, nunca com um PTY) — nem chega aqui: sem PTY nenhum
   * registrado pra esse kind, `isCardAlive` (já checado dentro de
   * `resolveLiveSpawner` acima) já é `false`, e o `listTerminalCards()`
   * abaixo também nunca o inclui.
   *
   * PONTEIRO, nunca o corpo (mesma decisão de desenho do popup) — a
   * MENSAGEM que `typeAndSubmit` entrega é fixa e curta, nunca o JSON do
   * relatório. */
  async function notifySpawnerOfReport(cardId: string) {
    // Mesma resolução de 2 fontes (ver `resolveNotifyTarget`/
    // report-notify-routing.ts) — diretiva mais recente ganha da linhagem
    // de spawn, cobrindo o caso de readoção sem regredir o caso comum.
    const spawnerId = resolveNotifyTarget(cardId);
    if (!spawnerId) {
      // DESIGN-BACKLOG.md §0, encaminhamento 3 — a falha que motivou esta
      // tarefa era 100% silenciosa: nem log, nem erro, só um `return`. O
      // report em si (`upsertReport`, chamado pelo cmd `report` antes
      // desta função) já rodou e continua acessível via `read_report` —
      // isto é só o aviso de que NINGUÉM vai ser empurrado até lá, pra não
      // levar uma sessão inteira pra alguém notar de novo.
      console.warn(`[report] ${callbacks.describeCardLabel(cardId)} produziu um relatório mas não há card vivo pra empurrar (sem diretiva recente nem spawner vivo) — use read_report pra consultar manualmente.`);
      return;
    }

    // Throttle apenas o popup humano. A entrega ao PTY abaixo entra numa
    // fila FIFO e nunca pode ser suprimida: depois que o porteiro existe,
    // usar este throttle para o caminho do agente perderia um report real.
    const now = Date.now();
    const last = lastReportNotifyAt.get(cardId) ?? 0;
    const notifyHuman = now - last >= REPORT_NOTIFY_MIN_INTERVAL_MS;
    if (notifyHuman) lastReportNotifyAt.set(cardId, now);

    const label = callbacks.describeCardLabel(cardId);
    // Canal 1 — o mesmo popup de SO do `notifyIdleCard`. Serve a um humano
    // de fato olhando a tela; o throttle não afeta o canal do agente.
    if (notifyHuman) callbacks.notifyCardReported(spawnerId, label);
    // Canal 2 — mesmo formato do `send_to_card` (prefixo `[de: X]`, depois
    // Enter com confirmação), único jeito de isto virar uma MENSAGEM de
    // verdade pro card de destino em vez de texto pendurado no prompt.
    if (listTerminalCards().some((c) => c.id === spawnerId)) {
      // AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
      // Typed into a PTY for another agent via typeAndSubmit. The `[de: …]`
      // prefix is a convention other code interprets; translating breaks
      // recognition. See `src/shared/i18n/agent-facing.ts`.
      await typeAndSubmit(spawnerId, `[de: ${label}] relatório disponível — chame read_report para ver o resultado.`);
    }
  }

  /** DESIGN-BACKLOG.md §2.1 "SINAL 2 — SAÍDA SEM RELATÓRIO" — mesma
   * resolução de linhagem que `notifySpawnerOfReport` acima
   * (`resolveLiveSpawner`), mesmos DOIS canais (popup de SO +
   * `typeAndSubmit` no PTY do spawner) — só a mensagem muda, não o
   * mecanismo, exatamente a mesma disciplina de "nunca uma 3ª variante"
   * que motivou extrair `typeAndSubmit` do cmd `send` em primeiro lugar.
   *
   * Chamada por `resolveCardExit` abaixo, sempre que um card sai sem
   * NUNCA ter chamado `report` — a MESMA condição que já derruba pra
   * `failed` a task (se houver uma) ligada a este card: "são os MESMOS
   * três sinais da derivação de status do quadro" (DESIGN-BACKLOG.md,
   * "Como o orquestrador descobre que um card terminou"), os dois efeitos
   * nascem do mesmo evento, por isso vivem lado a lado ali, não aqui
   * dentro (esta função só cuida do AVISO; quem decide `failed` é
   * `markTaskFailed`, já síncrono e já rodando antes desta chamar).
   *
   * Sem throttle — ao contrário do `report` (que um mesmo card pode
   * disparar várias rodadas seguidas), um card só sai uma vez. Fire-and-
   * forget: `resolveCardExit` não é `async` (chamada direto do `onExit`
   * do pty-registry, que também não é), então nada aguarda esta promise —
   * o pior caso de falha aqui é o aviso não chegar, nunca a marcação de
   * `failed` deixar de acontecer (já síncrona, antes desta linha). */
  async function notifySpawnerOfUnreportedExit(cardId: string, exitCode: number) {
    // Mesma resolução de 2 fontes que `notifySpawnerOfReport` já usa
    // (`resolveNotifyTarget`/report-notify-routing.ts, achado ao vivo
    // concorrente a esta tarefa) — diretiva mais recente ganha da
    // linhagem de spawn quando não há uma viva. Sinal 2 é irmão do sinal
    // 1 (mesma seção do backlog, "os MESMOS três sinais"); resolver a
    // linhagem de um jeito e do outro seria a 2ª variante que a própria
    // `resolveNotifyTarget` foi criada pra evitar.
    const spawnerId = resolveNotifyTarget(cardId);
    if (!spawnerId) return;
    const label = callbacks.describeCardLabel(cardId);
    callbacks.notifyCardExitedWithoutReport(spawnerId, label, exitCode);
    if (listTerminalCards().some((c) => c.id === spawnerId)) {
      // AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
      // Same [de: …] convention as the report-available notify above.
      await typeAndSubmit(spawnerId, `[de: ${label}] saiu (código ${exitCode}) sem chamar report.`);
    }
  }

  /** DESIGN-BACKLOG.md §2.1, decisão 5 — "arrastar a mão SEMPRE vale, e
   * AVISA o agente". Diferente de `notifySpawnerOfReport`/
   * `notifySpawnerOfUnreportedExit` acima (que resolvem a LINHAGEM de
   * spawn pra achar quem avisar), aqui o alvo já é conhecido de saída — o
   * próprio card vinculado à task que acabou de ser arrastada
   * (`tasks.card_id`), não o spawner de ninguém. Mesmo mecanismo
   * (`typeAndSubmit`) que os dois sinais acima já usam, nenhuma 3ª
   * variante; `message` já vem pronta do renderer (task-board-model.ts's
   * `describeHumanMove`) — este método só entrega. No-op silencioso se o
   * card não existe mais ou não é um terminal vivo (mesma postura
   * "aviso é best-effort, nunca bloqueia a gravação" dos outros dois —
   * a escrita de `status`/`order` já aconteceu antes desta chamada,
   * síncrona, em `index.ts`'s `persistTask`).
   *
   * ACHADO DE REVIEW ADVERSARIAL (RODADA 2, achado 4, MÉDIO) — digitar
   * texto+Enter num PTY sem saber o ESTADO do destinatário é uma
   * superfície já problemática por si só (bug aberto no backlog, §0:
   * "texto entregue a um card recém-spawnado fica na caixa sem
   * submeter" — o mesmo `typeAndSubmit` não sabe se quem está do outro
   * lado está pronto pra receber). Não é este método que conserta essa
   * raiz — só não a piora: um card `bash` (provider real, não um kind
   * diferente) não tem NENHUM agente do outro lado interpretando o
   * texto — vira comando de shell de verdade, e a resposta previsível é
   * "command not found" no meio do que quer que o card estivesse
   * fazendo. Excluído explicitamente (mesma convenção "bash não é
   * agente" de `countRunningAgentsOnBoard`/`cardWasExpectedToReport`) —
   * o mínimo que este achado pediu, não uma correção geral de prontidão
   * do destinatário (fora de escopo aqui). */
  async function notifyHumanMovedTask(cardId: string, message: string) {
    if (!callbacks.isCardAlive(cardId)) return;
    const card = listTerminalCards().find((c) => c.id === cardId);
    if (!card || card.provider === "bash") return;
    await typeAndSubmit(cardId, message);
  }

  /** Sticky item "card_status idle" — polls instead of hooking `onData`
   * directly: idle is defined by the ABSENCE of activity for a while, not
   * an event `pty-registry.ts` can ever fire on its own (there's nothing
   * to react to when nothing happens). `previousIdleState` is what turns
   * a level (idle right now) into an edge (JUST became idle) — without it
   * every tick after the first would "re-notify" a card that's been
   * sitting idle for an hour. Cleared on `close()` below. */
  const previousIdleState = new Map<string, boolean>();
  const idleWatchTimer = setInterval(() => {
    for (const card of listTerminalCards()) {
      if (waitingOnConsent.has(card.id) || !callbacks.isCardAlive(card.id)) {
        previousIdleState.delete(card.id);
        continue;
      }
      const idleNow = isCardIdle(card.id);
      const wasIdle = previousIdleState.get(card.id) ?? false;
      previousIdleState.set(card.id, idleNow);
      if (idleNow && !wasIdle) notifySpawnerOfIdleCard(card.id);
    }
  }, IDLE_WATCH_INTERVAL_MS);

  /** Achado ao vivo (2026-09-01): "eu renomeio os card dos agentes para
   * Stellar, isso só está visual em vez de funcional". Renomear escrevia
   * `cards.label` e parava aí — todo `target` do bus era comparado só
   * contra `c.id`, então o nome que o humano vê no header não servia pra
   * endereçar nada. Aqui o rótulo vira um alias real de id, resolvido uma
   * única vez na entrada do dispatcher (e não em cada `cmd`), de forma que
   * send, read_card, card_status, snapshot, os browser_ e report ganham
   * o alias todos de uma vez.
   *
   * Ordem deliberada: id exato SEMPRE primeiro. Um rótulo que por acaso
   * seja igual ao id de outro card nunca pode sequestrar aquele id — a
   * comparação por id é a que tem que ser inambígua, o rótulo é livre e
   * digitado por humano. Comparação de rótulo é case-insensitive e sem
   * espaços nas pontas (é um campo de texto livre); dois cards com o
   * mesmo rótulo viram erro explícito em vez de um "escolhi a primeira"
   * silencioso, que seria exatamente o tipo de acerto ao acaso que essa
   * feature não pode ter. */
  function resolveTargetId(raw: string): { id: string } | { error: string } {
    const cards = callbacks.listCards();
    if (cards.some((c) => c.id === raw)) return { id: raw };
    const needle = raw.trim().toLowerCase();
    if (!needle) return { id: raw };
    const byLabel = cards.filter((c) => (c.label ?? "").trim().toLowerCase() === needle);
    if (byLabel.length === 1) return { id: byLabel[0].id };
    if (byLabel.length > 1) {
      return { error: `"${raw}" matches ${byLabel.length} cards (${byLabel.map((c) => c.id).join(", ")}) — use the id instead` };
    }
    // Nem id nem rótulo: devolve cru, pra cada cmd emitir o próprio erro
    // ("no open terminal card with id ...") como sempre fez.
    return { id: raw };
  }

  /** Regra geral de auto-conector (2026-09-02) — "qualquer interação entre
   * cards via MCP conecta os dois, não só sticky": todo cmd que MUTA um
   * card que já existe (identificado por `target`) e carrega `requesterId`
   * entra aqui, mapeado pro `kind` gravado no conector. Um lugar só, não
   * uma chamada repetida em cada handler — cobre o cmd de hoje e qualquer
   * um que um tool novo adicionar amanhã, sem precisar lembrar de tocar
   * aqui toda vez (o jeito antigo, um `if` manual dentro do handler de
   * "send", já tinha ficado pra trás assim que `browser_*` ganhou os
   * mesmos 4 tools). Deliberadamente ausente: leituras (`list`, `read_*`,
   * `browser_query`/`snapshot`/`browser_console`/`browser_network`/
   * `browser_wait_for`, `card_status`, `get_report`, `list_tasks`,
   * `get_task`, `list_connectors`, `concurrency_status`, `board_mode`) —
   * olhar pra um card não é interagir com ele. Também ausente de propósito:
   * `write_sticky`/`set_sticky_color`/`set_sticky_mode` — essas 3 já
   * chamam `autoConnect` direto no `offSticky` do App.tsx (é lá que
   * `content`/`color`/`mode` realmente vivem, round-trip que já existia
   * por outro motivo); incluí-las aqui também dispararia um 2º push
   * redundante pro mesmo par (inofensivo — dedup do outro lado — mas sem
   * propósito). E `open`/`spawn_agent`/`spawn_card`: essas CRIAM um card
   * novo em vez de mutar um existente, `target` não é o card afetado (é
   * a URL/provider/kind pedido) — já têm seu próprio mecanismo mais
   * antigo (`kind: "spawned"`, App.tsx's spawnAgentFor/openBrowserFor/
   * spawnCardFor callers), não o generalizado aqui. */
  const AUTO_CONNECT_CMDS: Partial<Record<BusRequest["cmd"], string>> = {
    send: "modified",
    browser_click: "modified",
    browser_type: "modified",
    browser_scroll: "modified",
    browser_eval: "modified",
  };

  // Achado 3 (review adversarial, 2026-09-09) — C0/C1 control characters
  // plus the Unicode bidi override/embedding/isolate controls (LRE/RLE/
  // PDF/LRO/RLO and the newer LRI/RLI/FSI/PDI, plus the plain LRM/RLM
  // marks) stripped BEFORE truncation, not after: any of these dropped
  // into an SVG `<text>` (App.tsx's connector pill) can reorder or corrupt
  // the rendered line, and a label reaching this function came from
  // whatever an agent typed — never trusted as plain text before this.
  // Known, deliberately untreated gap (review adversarial rodada 2,
  // 2026-09-09) — combining marks (e.g. Zalgo-style stacks) aren't
  // filtered and can overflow the pill vertically. Low-probability
  // hostile input, and a filter here risks mangling ordinary accented
  // text (café, São Paulo) — left alone on purpose, not missed.
  // eslint-disable-next-line no-control-regex -- deliberate: this IS the sanitizer that strips C0/C1 control characters from an agent-supplied label (achado 3 above).
  const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

  /** Short one-line context for the connector's `label` (store.ts) — the
   * "why" behind an auto-connect, from whatever text was already in scope
   * for that mutation. Truncated here, once, so callers never have to
   * think about length; `null` when the request has no natural short text
   * (e.g. a scroll with no selector).
   * Achado 3 (review adversarial, 2026-09-09) — truncates by Unicode CODE
   * POINT (`Array.from`, which iterates a string per code point, not per
   * UTF-16 code unit), not by `.slice`: a raw `.slice(0, max)` can land
   * inside a surrogate pair and split an emoji/astral character in half,
   * leaving a broken/replacement glyph in the pill. This is the single
   * choke point every label passes through before reaching `store.ts`
   * (`deriveAutoConnectLabel` below, the `write_sticky` modified-label
   * call, and `set_connector_label`'s cmd handler all call this — none
   * truncate on their own), so the fix covers every label an agent can
   * set, not just spawn's.
   * Achado 1 (review adversarial RODADA 2, 2026-09-09) — ORDER bug: `\n`/
   * `\r`/`\t` are C0 controls, so the first version's
   * `.replace(CONTROL_AND_BIDI_RE, "")` deleted them outright, BEFORE
   * `/\s+/g` ever got a chance to collapse them into a separator — a
   * label like "ls -la\n/tmp" came out "ls -la/tmp", words glued
   * together. Fixed by converting real whitespace controls to a plain
   * space FIRST (so they survive as a separator), stripping the rest of
   * the C0/C1/bidi set second, THEN collapsing whitespace runs and
   * truncating — same final steps as before, just no longer racing the
   * control-strip against them. */
  function truncateForLabel(text: string, max = 60): string {
    const withRealWhitespace = text.replace(/[\n\r\t]/g, " ");
    const stripped = withRealWhitespace.replace(CONTROL_AND_BIDI_RE, "");
    const flat = stripped.trim().replace(/\s+/g, " ");
    const codePoints = Array.from(flat);
    return codePoints.length > max ? `${codePoints.slice(0, max - 1).join("")}…` : flat;
  }
  function deriveAutoConnectLabel(req: BusRequest): string | null {
    switch (req.cmd) {
      case "send":
        return req.text ? truncateForLabel(req.text) : null;
      case "browser_type":
        return req.text ? truncateForLabel(req.text) : req.selector ? truncateForLabel(req.selector) : null;
      case "browser_click":
      case "browser_scroll":
        return req.selector ? truncateForLabel(req.selector) : null;
      case "browser_eval":
        return req.js ? truncateForLabel(req.js) : null;
      default:
        return null;
    }
  }

  /** Shared by both frontends — see the module doc comment. Never throws;
   * every branch resolves to a `BusResponse`, including "unknown cmd".
   * Thin wrapper around `dispatchRequest` — the only thing added here is
   * the auto-connector rule above, so every caller (MCP, acbridge, the
   * internal recursive call in the socket server below) gets it for free
   * without dispatchRequest's ~30 `if (req.cmd === ...)` branches each
   * needing their own copy of the same 3 lines. Label→id resolution also
   * moved here (out of dispatchRequest) — `autoConnect` below needs the
   * REAL card id, not whatever label the caller happened to pass in
   * `target`; `dispatchRequest` used to do this resolution itself, on a
   * local shadowed `req` that never escaped it. */
  async function handleRequest(request: BusRequest): Promise<BusResponse> {
    let req = request;
    if ("target" in req && typeof req.target === "string") {
      const resolved = resolveTargetId(req.target);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      if (resolved.id !== req.target) req = { ...req, target: resolved.id };
    }
    const res = await dispatchRequest(req);
    const kind = AUTO_CONNECT_CMDS[req.cmd];
    if (kind && res.ok && "target" in req && req.target && "requesterId" in req && req.requesterId) {
      // `send` → kind "modified" is also the persisted directive route
      // (`pickLatestDirectiveSender` / resolveNotifyTarget). No separate
      // in-memory Map: the connector row is the single source of truth.
      callbacks.onAutoConnect(req.requesterId, req.target, kind, deriveAutoConnectLabel(req));
    }
    return res;
  }

  async function dispatchRequest(req: BusRequest): Promise<BusResponse> {
    if (req.cmd === "list") {
      return { ok: true, cards: callbacks.listCards() };
    }

    if (req.cmd === "send") {
      const cards = listTerminalCards();
      if (!req.target || !cards.some((c) => c.id === req.target)) {
        // Distingue "não existe" de "existe mas não é um terminal": o
        // segundo caso (mandar texto pra um sticky/navegador) é um pedido
        // legítimo que este cmd simplesmente não atende, e dizer só "no
        // open terminal card with id X" mandava o agente procurar um id
        // que ele já tinha certo.
        const any = callbacks.listCards().find((c) => c.id === req.target);
        if (any) return { ok: false, error: `card "${req.target}" is a ${any.kind} card — send_to_card only types into terminal cards` };
        return { ok: false, error: `no open terminal card with id "${req.target}"` };
      }
      const target = req.target;
      // DESIGN-BACKLOG.md item 61 — prefix with a human-friendly sender
      // label whenever the caller identifies itself. Optional and
      // additive: a caller that doesn't pass `requesterId` still delivers
      // exactly as before this item, unprefixed. Never for a `bash`
      // target: `send_to_card` doubles as "run this shell command" there
      // (the far more common use, see M2/M4's own examples) — a prefix
      // would be interpreted as the start of the command itself and
      // break it, not read as a header the way it does in a chat/agent
      // CLI's prose input.
      const targetProvider = cards.find((c) => c.id === target)?.provider;
      const senderLabel = req.requesterId && targetProvider !== "bash" ? callbacks.describeCardLabel(req.requesterId) : null;
      const text = senderLabel ? `[de: ${senderLabel}] ${req.text ?? ""}` : (req.text ?? "");
      // Regra geral de auto-conector (2026-09-02, generalizada a QUALQUER
      // interação entre cards via MCP — ver `AUTO_CONNECT_CMDS` no fim
      // deste arquivo, chamado de dentro do `handleRequest` wrapper) —
      // nada a fazer aqui, o wrapper cuida disso depois que este bloco
      // devolver `{ok:true}`.
      await typeAndSubmit(target, text);
      return { ok: true };
    }

    if (req.cmd === "open") {
      if (!req.url) return { ok: false, error: "missing url" };
      const openUrlError = navigationUrlError(req.url);
      if (openUrlError) return { ok: false, error: openUrlError };
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      // DESIGN-BACKLOG.md item 60, peça 5 — modo autônomo completo:
      // auto-approve extended here too, same board-scoped opt-in as
      // spawn_agent (item 59). No concurrency cap involved — that only
      // ever gates spawn_agent.
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      markWaiting(requesterId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingOpens.delete(requestId);
          unmarkWaiting(requesterId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, OPEN_TIMEOUT_MS);
        pendingOpens.set(requestId, {
          resolve: (allowed, cardId) => {
            clearTimeout(timer);
            pendingOpens.delete(requestId);
            unmarkWaiting(requesterId);
            // `cardId` é opcional na assinatura só por robustez (um
            // renderer antigo, ou uma recusa, não tem id nenhum pra
            // mandar) — no caminho de permitir ele vem sempre.
            resolve(allowed ? { ok: true, ...(cardId ? { cardId } : {}) } : { ok: false, error: "denied by user" });
          },
          timer,
        });
        callbacks.onOpenRequest(requestId, requesterId, req.url as string, req.reason, autonomous);
      });
    }

    // Sticky item "close_card" (2026-09-03) — "o orquestrador não consegue
    // fechar o card ou qualquer outro card, sem poder" — `closeCard()`
    // (App.tsx) always existed but only ever behind the UI's own X button,
    // no MCP/acbridge path reached it. Same ask/consent/resolve shape as
    // `open` above, generalized to any card kind (not just terminal — see
    // `onCloseCardRequest`'s own doc comment).
    if (req.cmd === "close_card") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const target = req.target;
      if (!callbacks.listCards().some((c) => c.id === target)) return { ok: false, error: `no open card with id "${target}"` };
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      markWaiting(requesterId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingCloseCards.delete(requestId);
          unmarkWaiting(requesterId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, CLOSE_TIMEOUT_MS);
        pendingCloseCards.set(requestId, {
          resolve: (allowed) => {
            clearTimeout(timer);
            pendingCloseCards.delete(requestId);
            unmarkWaiting(requesterId);
            resolve(allowed ? { ok: true } : { ok: false, error: "denied by user" });
          },
          timer,
        });
        callbacks.onCloseCardRequest(requestId, requesterId, target, req.reason, autonomous);
      });
    }

    if (req.cmd === "delete_card") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const target = req.target;
      // Already on the loaded board — close_card handles this exact card
      // today (live-terminal reconfirm, consent modal/autonomous gate);
      // delegate instead of a second, subtly different implementation.
      if (callbacks.listCards().some((c) => c.id === target)) {
        return handleRequest({ cmd: "close_card", target, requesterId: req.requesterId, reason: req.reason });
      }
      const any = callbacks.getAnyCard(target);
      if (!any) return { ok: false, error: `no card with id "${target}"` };
      // No loaded board means no live UI to ever show a human a consent
      // modal through — the only safe path left is the same contract
      // spawn_card/open_url already use for "no human in the loop, but
      // this board is explicitly fine with it": THAT card's own board
      // being autonomous, not the requester's.
      if (!callbacks.isBoardAutonomous(any.boardId)) {
        return {
          ok: false,
          error: `card "${target}" is on board "${any.boardId}", which isn't currently loaded — load that board and use close_card, or turn on autonomous mode for it first`,
        };
      }
      callbacks.deleteCardDirect(target);
      return { ok: true };
    }

    if (req.cmd === "update_card_content") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (req.content === undefined) return { ok: false, error: "missing content" };
      const mode = req.mode ?? "replace";
      if (mode !== "replace" && mode !== "append") return { ok: false, error: `mode must be "replace" or "append"` };
      const target = req.target;
      if (callbacks.listCards().some((c) => c.id === target)) {
        return handleRequest({ cmd: "write_sticky", target, content: req.content, mode, requesterId: req.requesterId });
      }
      const any = callbacks.getAnyCard(target);
      if (!any) return { ok: false, error: `no card with id "${target}"` };
      if (any.kind !== "sticky") {
        return { ok: false, error: `card "${target}" is a ${any.kind} card — update_card_content only works on sticky notes` };
      }
      if (!callbacks.isBoardAutonomous(any.boardId)) {
        return {
          ok: false,
          error: `card "${target}" is on board "${any.boardId}", which isn't currently loaded — load that board and use write_sticky, or turn on autonomous mode for it first`,
        };
      }
      const result = callbacks.updateStickyContentDirect(target, req.content, mode);
      if (result.ok && req.requesterId) {
        callbacks.onAutoConnect(req.requesterId, target, "modified", truncateForLabel(req.content));
      }
      return result;
    }

    if (req.cmd === "snapshot") {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSnapshots.delete(requestId);
          callbacks.onSnapshotTimeout(requestId);
          resolve({ ok: false, error: "timed out capturing snapshot" });
        }, SNAPSHOT_TIMEOUT_MS);
        pendingSnapshots.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingSnapshots.delete(requestId);
            resolve(result);
          },
          timer,
        });
        const target = req.rect ? { rect: req.rect } : req.target ? { cardId: req.target } : null;
        callbacks.onSnapshotRequest(requestId, target);
      });
    }

    if (req.cmd === "get_page_text") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingPageTexts.delete(requestId);
          resolve({ ok: false, error: "timed out reading page text" });
        }, PAGE_TEXT_TIMEOUT_MS);
        pendingPageTexts.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingPageTexts.delete(requestId);
            resolve(result);
          },
          timer,
        });
        callbacks.onPageTextRequest(requestId, req.target as string);
      });
    }

    if (req.cmd === "read_card") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return readCardText(req.target, req.lines);
    }

    // Sem modal de consentimento, decidido com o usuário (2026-09-01): uma
    // nota é conteúdo do board, não um efeito colateral em disco ou
    // processo — a categoria que a política de consentimento cobre
    // (`write_file`, `bash`, `spawn_agent`, `open_url`, ver AGENTS.md §3).
    // A proteção que importa aqui é outra e vive no renderer: uma nota que
    // um humano está editando NAQUELE instante recusa a escrita em vez de
    // apagar o que a pessoa está digitando.
    if (
      req.cmd === "read_sticky" ||
      req.cmd === "write_sticky" ||
      req.cmd === "set_sticky_color" ||
      req.cmd === "set_sticky_mode"
    ) {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const card = callbacks.listCards().find((c) => c.id === req.target);
      if (!card) return { ok: false, error: `no card with id "${req.target}"` };
      if (card.kind !== "sticky") {
        return { ok: false, error: `card "${req.target}" is a ${card.kind} card — ${req.cmd} only works on sticky notes` };
      }
      if (req.cmd === "read_sticky") return stickyOp(req.target, { op: "read" });
      if (req.cmd === "set_sticky_color") {
        if (!req.color || !STICKY_COLORS.includes(req.color as (typeof STICKY_COLORS)[number])) {
          return { ok: false, error: `color must be one of ${STICKY_COLORS.join(", ")}` };
        }
        return stickyOp(req.target, { op: "set_color", color: req.color, requesterId: req.requesterId });
      }
      if (req.cmd === "set_sticky_mode") {
        if (req.mode !== "edit" && req.mode !== "preview") {
          return { ok: false, error: `mode must be "edit" or "preview"` };
        }
        return stickyOp(req.target, { op: "set_mode", mode: req.mode, requesterId: req.requesterId });
      }
      if (req.content === undefined) return { ok: false, error: "missing content" };
      const mode = req.mode ?? "replace";
      if (mode !== "replace" && mode !== "append") return { ok: false, error: `mode must be "replace" or "append"` };
      return stickyOp(req.target, { op: "write", content: req.content, mode, requesterId: req.requesterId });
    }

    // DESIGN-BACKLOG.md §2.1 — the 5 browser control cmds. Unlike
    // `snapshot`/`get_page_text` above, resolution here is 100% local to
    // THIS process (`browser-registry.ts`'s methods, called straight
    // from index.ts's callbacks, no round trip to the renderer) — no
    // pending-map/timeout ceremony needed, same shape as `card_status`/
    // `board_mode` below: call the callback, return what it resolves to.
    if (req.cmd === "browser_click") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.ref && !req.selector && (req.x === undefined || req.y === undefined)) {
        return { ok: false, error: "need a ref (from browser_snapshot), a selector, or both x and y" };
      }
      return callbacks.browserClick(req.target, req.x, req.y, req.selector, req.ref);
    }

    if (req.cmd === "browser_type") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (req.text === undefined) return { ok: false, error: "missing text" };
      return callbacks.browserType(req.target, req.text, req.selector, req.ref);
    }

    if (req.cmd === "browser_scroll") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserScroll(req.target, req.dx ?? 0, req.dy ?? 0, req.selector, req.ref);
    }

    if (req.cmd === "browser_query") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.selector && !req.ref) return { ok: false, error: "need a selector or a ref (from browser_snapshot)" };
      return callbacks.browserQuery(req.target, req.selector, req.ref);
    }

    if (req.cmd === "browser_eval") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.js) return { ok: false, error: "missing js" };
      return callbacks.browserEval(req.target, req.js);
    }

    if (req.cmd === "browser_snapshot") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserSnapshot(req.target);
    }

    if (req.cmd === "browser_console") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserConsole(req.target, req.level, req.limit);
    }

    if (req.cmd === "browser_network") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      return callbacks.browserNetwork(req.target, {
        status: req.status,
        failedOnly: req.failedOnly,
        urlContains: req.urlContains,
        limit: req.limit,
      });
    }

    if (req.cmd === "browser_wait_for") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (!req.selector && !req.text) return { ok: false, error: "need either selector or text" };
      return callbacks.browserWaitFor(req.target, {
        selector: req.selector,
        text: req.text,
        gone: req.gone,
        timeoutMs: req.timeoutMs,
      });
    }

    if (req.cmd === "card_status") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const cards = listTerminalCards();
      if (!cards.some((c) => c.id === req.target)) return { ok: false, error: `no open terminal card with id "${req.target}"` };
      // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 2 —
      // checked BEFORE isAlive: a card blocked on its own consent modal is
      // still a live process (isAlive true), but reporting "running" here
      // is exactly the ambiguity this state exists to remove.
      if (waitingOnConsent.has(req.target)) return { ok: true, status: "waiting" };
      if (!callbacks.isCardAlive(req.target)) return { ok: true, status: "exited" };
      return { ok: true, status: isCardIdle(req.target) ? "idle" : "running" };
    }

    if (req.cmd === "turn_complete") {
      if (!req.cardId) return { ok: false, error: "missing cardId (your own card id)" };
      callbacks.notifyTurnComplete(req.cardId);
      return { ok: true };
    }

    if (req.cmd === "report") {
      if (!req.requesterId) return { ok: false, error: "missing requesterId (your own card id)" };
      const stored: StoredReport = { report: req.report, seq: ++reportSeqCounter, verdict: req.verdict ?? null };
      // DESIGN-BACKLOG.md §2.1 — persiste ANTES de resolver waiters/avisar
      // o spawner: se o processo morrer bem aqui no meio (mesma classe de
      // evento que motivou esta tarefa), o pior caso agora é um waiter que
      // não foi acordado desta vez — não um relatório que nunca existiu.
      // `report_json` é o mesmo `JSON.stringify` que `update_task` já faz
      // pra `result_json` (mesma convenção, não uma nova).
      const now = Date.now();
      callbacks.upsertReport({
        card_id: req.requesterId,
        seq: stored.seq,
        report_json: JSON.stringify(stored.report),
        verdict: stored.verdict,
        updated_at: now,
      });
      // DESIGN-BACKLOG.md §2.1 "Histórico de veredito por participação" —
      // todo `report` fecha uma RODADA de participação, tenha `verdict`
      // ou não (`verdict: null` é "esta rodada terminou sem veredito
      // nenhum", tão real quanto "aprovado"/"reprovado"). Choke point:
      // este é o único lugar que grava um report vindo de fora, então é
      // o único lugar que precisa lembrar de chamar isto — ver o
      // comentário grande de `recordParticipationRound` no callback.
      callbacks.recordParticipationRound(req.requesterId, stored.verdict ?? null, now);
      // Parte 2b — cada waiter carrega o próprio `afterSeq`; só resolve
      // (e sai da fila) quem esse relatório novo de fato satisfaz. Os que
      // sobram (raro — normalmente há no máximo um waiter por card)
      // continuam esperando um `seq` ainda maior.
      const waiters = pendingReportWaiters.get(req.requesterId);
      if (waiters) {
        const remaining = waiters.filter((w) => {
          if (stored.seq <= w.afterSeq) return true;
          w.resolve(stored);
          return false;
        });
        if (remaining.length === 0) pendingReportWaiters.delete(req.requesterId);
        else pendingReportWaiters.set(req.requesterId, remaining);
      }
      // Parte 1/2 — "ja acabou, novamente você não tem informação": mesmo
      // caminho do idle (resolve pra quem empurrar via `resolveNotifyTarget`),
      // aviso só com o ponteiro — ver `notifySpawnerOfReport` acima.
      await notifySpawnerOfReport(req.requesterId);
      return { ok: true, seq: stored.seq };
    }

    if (req.cmd === "get_report") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const target = req.target;
      const afterSeq = req.afterSeq;
      // Sem afterSeq: mais recente. Com afterSeq: próximo (seq > afterSeq),
      // para caminhar histórico append-only depois do fato.
      const storedRow = callbacks.getReport(target, afterSeq);
      const current: StoredReport | undefined = storedRow
        ? { report: JSON.parse(storedRow.report_json), seq: storedRow.seq, verdict: storedRow.verdict ?? null }
        : undefined;
      if (current) {
        return { ok: true, report: current.report, seq: current.seq, verdict: current.verdict ?? null };
      }
      if (!req.wait) return { ok: false, error: afterSeq === undefined ? "no report yet" : "no report newer than the given sequence yet" };
      const timeoutMs = req.timeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
      // `afterSeq ?? -1`: sem valor informado, qualquer relatório que
      // chegue (seq sempre >= 1) já satisfaz — mesmo "espera o primeiro
      // que vier" de sempre.
      const threshold = afterSeq ?? -1;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const waiters = pendingReportWaiters.get(target);
          if (waiters) {
            const idx = waiters.indexOf(entry);
            if (idx !== -1) waiters.splice(idx, 1);
            if (waiters.length === 0) pendingReportWaiters.delete(target);
          }
          resolve({ ok: false, error: "timed out waiting for report" });
        }, timeoutMs);
        const entry = {
          afterSeq: threshold,
          resolve: (stored: StoredReport) => {
            clearTimeout(timer);
            resolve({ ok: true, report: stored.report, seq: stored.seq, verdict: stored.verdict ?? null });
          },
        };
        const waiters = pendingReportWaiters.get(target) ?? [];
        waiters.push(entry);
        pendingReportWaiters.set(target, waiters);
      });
    }

    if (req.cmd === "create_task") {
      const now = Date.now();
      const id = randomUUID();
      // DESIGN-BACKLOG.md item 60, peça 3 — explicit `boardId` wins (the
      // only way to scope a task that has no `cardId` yet, e.g. one
      // meant to sit `pending` until its deps finish); falls back to the
      // `cardId`'s own board when only that's given. `null` when
      // neither is passed — that task is never a candidate for
      // auto-dispatch, pure external-orchestrator bookkeeping as before
      // this column existed.
      const boardId = req.boardId ?? (req.cardId ? (callbacks.getCardBoardId(req.cardId) ?? null) : null);
      // RODADA 4 — recusa em vez de gravar em silêncio. Só valida quando
      // `boardId` acabou não-null: um board inferido de `cardId` que já
      // não resolveu a card nenhum (card fechado, board dele já
      // deletado) já cai em `null` pela linha acima, então chega aqui
      // como bookkeeping puro de propósito, nunca precisando de board
      // nenhum — não é o caso que este check existe pra pegar.
      if (boardId !== null && !callbacks.boardExists(boardId)) {
        return { ok: false, error: `no such board "${boardId}" — check list_tasks/the board list before retrying, or omit boardId for a bookkeeping-only task` };
      }
      callbacks.upsertTask({
        id,
        prompt: req.prompt ?? null,
        provider: req.provider ?? null,
        status: req.cardId ? "running" : "pending",
        card_id: req.cardId ?? null,
        board_id: boardId,
        // Explicit only — never inferred from card/board/repo. Empty string
        // collapses to null (same as omitted): board-root fallback at dispatch.
        cwd: resolveTaskDispatchCwd(req.cwd) ?? null,
        result_json: null,
        deps_json: req.deps ? JSON.stringify(req.deps) : null,
        retry_count: 0,
        attempted_providers_json: req.provider ? JSON.stringify([req.provider]) : null,
        max_retries: req.maxRetries ?? null,
        fallback_providers_json: req.fallbackProviders ? JSON.stringify(req.fallbackProviders) : null,
        order: null,
        suggested_order: req.suggestedOrder ?? null,
        implicit_order: null,
        diverged_status: null,
        diverged_actor: null,
        created_at: now,
        updated_at: now,
        // create_task só existe como MCP tool hoje — todo chamador é um
        // agente. Explícito aqui em vez de deixar pro default do store,
        // pelo mesmo motivo de "não adivinhar": este ponto SABE quem é.
        actor: "agent",
      });
      return { ok: true, taskId: id };
    }

    if (req.cmd === "update_task") {
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      const existing = callbacks.getTask(req.taskId);
      if (!existing) return { ok: false, error: `no such task "${req.taskId}"` };
      // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 5 — pure
      // bookkeeping an external orchestrator's own retry/reassignment loop
      // can lean on instead of tracking this itself: `incrementRetry`
      // bumps the counter, `attemptedProvider` appends to the list (both
      // additive, never overwritten wholesale like the other fields).
      const attemptedProviders: string[] = existing.attempted_providers_json ? JSON.parse(existing.attempted_providers_json) : [];
      if (req.attemptedProvider) attemptedProviders.push(req.attemptedProvider);
      // Decisão 8 / review adversarial achado 3 — `statusProposed: false`
      // when the agent omitted `status`: the bus must NOT inject
      // `existing.status` as if it were an alignment proposal (that used
      // to clear a live divergence in silence). Other fields still update.
      const statusProposed = req.status !== undefined;
      // DESIGN-BACKLOG.md §2.1 "Falha TIPADA" — failureKind is always
      // derived by the app, never accepted from an agent's `result`.
      // Strip forged kinds; keep any server stamp already on the row.
      let result_json =
        req.result !== undefined ? mergeAgentResultJson(req.result, existing.result_json) : existing.result_json;
      // Explicit agent fail is julgada (stays in "falhou", counts in sprint).
      if (statusProposed && req.status === "failed") {
        result_json = stampFailureKindJson(result_json, decideFailureKind("explicit_failed"));
      }
      const now = Date.now();
      let prompt = existing.prompt;
      if (req.prompt !== undefined) {
        const mode = req.promptMode ?? "append";
        if (mode !== "append" && mode !== "replace") {
          return { ok: false, error: `promptMode must be "append" or "replace"` };
        }
        const applied = applyTaskPromptWrite({ existing: existing.prompt, incoming: req.prompt, mode, at: now });
        if (!applied.ok) return applied;
        prompt = applied.prompt;
      }
      const updated: TaskRow = {
        ...existing,
        prompt,
        status: statusProposed ? req.status! : existing.status,
        card_id: req.cardId !== undefined ? req.cardId : existing.card_id,
        result_json,
        retry_count: existing.retry_count + (req.incrementRetry ? 1 : 0),
        attempted_providers_json: attemptedProviders.length > 0 ? JSON.stringify(attemptedProviders) : existing.attempted_providers_json,
        suggested_order: req.suggestedOrder !== undefined ? req.suggestedOrder : existing.suggested_order,
        updated_at: now,
        actor: "agent",
        statusProposed,
      };
      // DESIGN-BACKLOG.md §2.1 Decisão 8 — a precedência mora no choke
      // point (`upsertTask` → `decideStatusWrite`). Side effects abaixo
      // (onTaskDone / retryOrFail) só disparam quando o status de fato
      // MUDOU — um hold humano NÃO pode desbloquear dependentes nem
      // auto-retentar como se a task tivesse chegado em done/failed.
      const decision = callbacks.upsertTask(updated);
      if (decision.statusChanged && decision.status === "done" && existing.status !== "done") onTaskDone(req.taskId);
      if (decision.statusChanged && decision.status === "failed" && existing.status !== "failed") {
        retryOrFail({ ...updated, status: decision.status });
      }
      const promptWritten = req.prompt !== undefined ? { prompt } : {};
      if (decision.warnAgent) {
        const warning = describeStatusHeldWarning(decision.status, decision.declaredStatus ?? req.status ?? decision.status);
        // Review adversarial achado 4 — typeAndSubmit ONLY to requesterId.
        // Falling back to `updated.card_id` typed the warning into the
        // implementer's PTY (corrupting an innocent session). No requester
        // → MCP `warning` field alone; never notify the wrong card.
        if (req.requesterId) notifyHumanMovedTask(req.requesterId, warning).catch(() => {});
        return { ok: true, warning, status: decision.status, divergedStatus: decision.divergedStatus, ...promptWritten };
      }
      return { ok: true, ...promptWritten };
    }

    if (req.cmd === "list_tasks") {
      // DESIGN-BACKLOG.md §2.1 item 6 — review adversarial achado
      // (2026-09-10): a versão anterior filtrava em JS sobre o resultado
      // COMPLETO de `callbacks.listTasks()` mesmo quando `boardId` era
      // passado, carregando a tabela inteira pra memória do Node só pra
      // descartar a maior parte dela. `index.ts` estava travado por outro
      // agente quando esse gap foi documentado — agora liberado, a fiação
      // é ligada de verdade: `callbacks.listTasksByBoard` chama
      // `store.listTasksByBoard` (usa `idx_tasks_board_id`), o mesmo
      // statement já coberto por teste direto contra o store. Sem
      // `boardId`: idêntico a antes (`listTasks()` sem filtro).
      const tasks = req.boardId ? callbacks.listTasksByBoard(req.boardId) : callbacks.listTasks();
      return { ok: true, tasks: tasks.map(serializeTask) };
    }

    if (req.cmd === "get_task") {
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      const task = callbacks.getTask(req.taskId);
      if (!task) return { ok: false, error: `no such task "${req.taskId}"` };
      return { ok: true, task: serializeTask(task) };
    }

    if (req.cmd === "request_task_status") {
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      if (!req.status) return { ok: false, error: "missing status" };
      const existing = callbacks.getTask(req.taskId);
      if (!existing) return { ok: false, error: `no such task "${req.taskId}"` };
      const requesterBoardId = req.requesterId ? callbacks.getCardBoardId(req.requesterId) : undefined;
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      const decision = decideStatusAsk({
        currentStatus: existing.status,
        requestedStatus: req.status,
        existingDivergedStatus: existing.diverged_status,
        existingDivergedActor: existing.diverged_actor,
        boardAutonomous: autonomous,
      });
      if (decision.outcome === "already") {
        return {
          ok: true,
          pending: false,
          already: true,
          status: existing.status,
          message: describeStatusAskAlready(existing.status),
        };
      }
      if (!callbacks.setStatusAsk) {
        return { ok: false, error: "status ask is unavailable in this session" };
      }
      const parked = callbacks.setStatusAsk(req.taskId, {
        status: req.status,
        reason: req.reason?.trim() ? req.reason.trim() : null,
        requesterId: req.requesterId ?? null,
        at: Date.now(),
      });
      if (!parked.ok) return parked;
      return {
        ok: true,
        pending: true,
        already: false,
        status: existing.status,
        requestedStatus: req.status,
        divergedStatus: decision.divergedStatus,
        message: describeStatusAskParked(req.status, existing.status),
      };
    }

    function serializeSprint(s: import("./store").SprintRow) {
      return {
        id: s.id,
        boardId: s.board_id,
        number: s.number,
        name: s.name,
        startedAt: s.started_at,
        closedAt: s.closed_at,
        countTodo: s.count_todo,
        countDoing: s.count_doing,
        countDone: s.count_done,
        countFailed: s.count_failed,
        migratedIn: s.migrated_in,
        migratedOut: s.migrated_out,
        hasSnapshot: s.snapshot_json != null,
      };
    }

    if (req.cmd === "list_sprints") {
      if (!req.boardId) return { ok: false, error: "missing boardId" };
      if (!callbacks.boardExists(req.boardId)) return { ok: false, error: `no such board "${req.boardId}"` };
      return { ok: true, sprints: callbacks.listSprints(req.boardId).map(serializeSprint) };
    }

    if (req.cmd === "open_sprint") {
      if (!req.boardId) return { ok: false, error: "missing boardId" };
      const result = callbacks.openSprint(req.boardId);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(req.boardId);
      return { ok: true, sprint: serializeSprint(result.sprint) };
    }

    if (req.cmd === "close_sprint") {
      if (!req.boardId) return { ok: false, error: "missing boardId" };
      const result = callbacks.closeSprint(req.boardId);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(req.boardId);
      return { ok: true, closed: serializeSprint(result.closed), opened: serializeSprint(result.opened) };
    }

    if (req.cmd === "rename_sprint") {
      if (!req.sprintId) return { ok: false, error: "missing sprintId" };
      const name = req.name === undefined ? null : req.name;
      const result = callbacks.renameSprint(req.sprintId, name);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(result.sprint.board_id);
      return { ok: true, sprint: serializeSprint(result.sprint) };
    }

    if (req.cmd === "delete_sprint") {
      if (!req.sprintId) return { ok: false, error: "missing sprintId" };
      const result = callbacks.deleteSprint(req.sprintId);
      if (!result.ok) return result;
      callbacks.onSprintsChanged?.(result.deleted.board_id);
      return {
        ok: true,
        deleted: serializeSprint(result.deleted),
        restored: result.restored ? serializeSprint(result.restored) : null,
        movedTaskCount: result.movedTaskCount,
      };
    }

    if (req.cmd === "list_connectors") {
      return {
        ok: true,
        connectors: callbacks.listAllConnectors().map((c) => ({
          id: c.id,
          fromCardId: c.from_card_id,
          toCardId: c.to_card_id,
          kind: c.kind,
          label: c.label,
        })),
      };
    }

    if (req.cmd === "set_connector_kind") {
      if (!req.connectorId) return { ok: false, error: "missing connectorId" };
      // DESIGN-BACKLOG.md item 62 — "spawned" included here so an
      // orchestrator/human can also manually apply or clear it, even
      // though the app itself only ever sets it automatically (see
      // `addConnector` in App.tsx) — this cmd never sets it on its own.
      const validKinds = ["context", "depends", "spawned", null];
      if (req.kind !== undefined && !validKinds.includes(req.kind)) {
        return { ok: false, error: `kind must be one of context, depends, spawned, or null` };
      }
      const kind = req.kind ?? null;
      // Guarda de autoria — RODADA 2 (card 337, "fila 85975417"):
      // estreitada pra só se aplicar quando a escrita afeta linhagem
      // `spawned` (setar `spawned`, ou mexer num conector que JÁ era
      // `spawned`); qualquer outra (context/depends/null advisory) é
      // livre — ver `connector-kind-authorization.ts` pro porquê e pro
      // que isso destrava. Roda ANTES do write: recusar depois de gravar
      // não recusaria nada. Mesma leitura que `resolveLiveSpawner` já faz
      // deste conjunto, sem callback novo.
      const endpoints = callbacks
        .listAllConnectors()
        .find((c) => c.id === req.connectorId);
      // Conector inexistente responde com a MESMA mensagem (id incluso) de
      // antes desta guarda — quem depura um id errado precisa ver qual id
      // foi. A guarda de autoria só opina sobre conector que existe.
      if (!endpoints) return { ok: false, error: `no such connector "${req.connectorId}"` };
      const decision = decideConnectorKindWrite(
        req.requesterId,
        { fromCardId: endpoints.from_card_id, toCardId: endpoints.to_card_id, currentKind: endpoints.kind },
        kind,
      );
      if (!decision.allowed) return { ok: false, error: decision.error };
      const found = callbacks.setConnectorKind(req.connectorId, kind);
      if (!found) return { ok: false, error: `no such connector "${req.connectorId}"` };
      // Ver `onConnectorKindChanged` — mesma ordem do irmão
      // `set_connector_label` logo abaixo: só empurra DEPOIS de o UPDATE
      // ter confirmado que a linha existe, senão um id inválido faria o
      // renderer receber push de um conector que não está lá.
      callbacks.onConnectorKindChanged(req.connectorId, kind, callbacks.getConnectorBoardId(req.connectorId));
      return { ok: true };
    }

    if (req.cmd === "set_connector_label") {
      // 2026-09-09 — "contextualizar em tempo real": the explicit-update
      // half of the feature (the automatic half lives in App.tsx's
      // `autoConnect`, which refreshes an EXISTING connector's label on a
      // later `send`/etc. between the same pair). This is for a caller
      // that wants to set it directly — e.g. an orchestrator annotating
      // what a dependent card is doing right now, same spirit as
      // `set_connector_kind` letting it tag `depends`/`context` by hand.
      if (!req.connectorId) return { ok: false, error: "missing connectorId" };
      const label = req.label ? truncateForLabel(req.label) : null;
      const found = callbacks.setConnectorLabel(req.connectorId, label);
      if (!found) return { ok: false, error: `no such connector "${req.connectorId}"` };
      // Achado 2 (review adversarial, 2026-09-09) — passes the connector's
      // OWN board along so index.ts can filter against whichever board is
      // actually open before pushing; this cmd handler doesn't know or
      // care which board that is, it just always looks the connector's up
      // and hands it over (`getConnectorBoardId` returns `undefined` in
      // the unlikely case the row vanished between the UPDATE above and
      // this lookup — index.ts's filter naturally drops that too, since
      // `undefined !== activeBoardId`).
      callbacks.onConnectorLabelChanged(req.connectorId, label, callbacks.getConnectorBoardId(req.connectorId));
      return { ok: true };
    }

    if (req.cmd === "concurrency_status") {
      // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 6 — a
      // real count (`isCardAlive`, not just "has a card row"), same
      // "bash isn't an agent" convention `store.ts`'s cardCounts already
      // uses. Purely advisory — this app doesn't queue or refuse a spawn
      // over this. Deciding what to do with the number is up to whoever
      // calls it.
      const running = listTerminalCards().filter((c) => c.provider !== "bash" && callbacks.isCardAlive(c.id)).length;
      const cap = req.cap ?? DEFAULT_CONCURRENCY_CAP;
      return { ok: true, running, cap, atCap: running >= cap };
    }

    if (req.cmd === "board_mode") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const boardId = callbacks.getCardBoardId(req.target);
      if (!boardId) return { ok: false, error: `no such card "${req.target}"` };
      // DESIGN-BACKLOG.md item 60, peça 2 — `concurrencyCap` always
      // reports the EFFECTIVE cap (board override, else the global
      // default), never null, so a caller never has to know the fallback
      // constant itself.
      return {
        ok: true,
        autonomous: callbacks.isBoardAutonomous(boardId),
        concurrencyCap: callbacks.getBoardConcurrencyCap(boardId) ?? DEFAULT_CONCURRENCY_CAP,
        // DESIGN-BACKLOG.md item 60, peça 1 — lets a caller introspect
        // queue depth without a dedicated tool; 0 for every board that
        // isn't autonomous (the queue only ever applies there).
        queueLength: (spawnQueue.get(boardId) ?? []).length,
      };
    }

    if (req.cmd === "spawn_agent") {
      if (!req.provider) return { ok: false, error: "missing provider" };
      // CLAUDE_EFFORT_VALUES / ANTIGRAVITY_EFFORT_VALUES's own comment
      // above has the full decision writeup (refuse, never silently
      // remap). Checked before the spawn-depth budget below is touched —
      // an invalid request shouldn't cost the caller part of its
      // recursion allowance.
      if (req.provider === "antigravity" && req.effort !== undefined && !ANTIGRAVITY_EFFORT_VALUES.has(req.effort)) {
        return {
          ok: false,
          error: `antigravity only accepts effort "low", "medium", or "high", got "${req.effort}" — refusing to spawn rather than silently substituting a different value`,
        };
      }
      if (req.provider === "claude" && req.effort !== undefined && !CLAUDE_EFFORT_VALUES.has(req.effort)) {
        return {
          ok: false,
          error: `claude only accepts effort "low", "medium", "high", "xhigh", or "max", got "${req.effort}" — refusing to spawn rather than silently substituting a different value`,
        };
      }
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      // Pre-release audit S4 — ignores `req.depth` entirely; see
      // `cardSpawnDepth`'s own comment above for why.
      const requesterDepth = requesterId ? (cardSpawnDepth.get(requesterId) ?? 0) : 0;
      if (requesterDepth >= MAX_SPAWN_DEPTH) {
        return { ok: false, error: `spawn depth limit reached (max ${MAX_SPAWN_DEPTH}) — refusing to spawn another agent` };
      }
      const depth = requesterDepth + 1;
      // DESIGN-BACKLOG.md item 59 — the ONE place `autoApprove` can ever
      // become true: the requester's own board opted in via the human-
      // only UI toggle. No MCP/acbridge cmd reaches this flag.
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      const spawnParams = {
        provider: req.provider as string,
        cwd: req.cwd,
        resumeId: req.resumeId,
        depth,
        reason: req.reason,
        model: req.model,
        effort: req.effort,
        label: req.label,
      };
      const spawnResult: SpawnAgentResult =
        autonomous && requesterBoardId
          ? await autonomousSpawn(requesterBoardId, requestId, requesterId, spawnParams)
          : await dispatchSpawnAgentRequest(requestId, requesterId, spawnParams, false);
      if (spawnResult.ok) cardSpawnDepth.set(spawnResult.cardId, depth);
      // DESIGN-BACKLOG.md item 58, M4 — `wait: true` holds this call open
      // past "the human approved and the card exists" (spawnResult above)
      // until the process actually exits, so the caller gets a real
      // completion signal instead of having to poll card_status/snapshot
      // in a loop. Not an error if the wait window runs out first — the
      // spawn itself still succeeded, it's just still running.
      if (!req.wait || !spawnResult.ok) return spawnResult;
      const cardId = spawnResult.cardId;
      const exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          const waiters = pendingCardExits.get(cardId);
          if (waiters) {
            const idx = waiters.indexOf(onExit);
            if (idx !== -1) waiters.splice(idx, 1);
            if (waiters.length === 0) pendingCardExits.delete(cardId);
          }
          resolve(null);
        }, req.waitTimeoutMs ?? DEFAULT_WAIT_EXIT_TIMEOUT_MS);
        const onExit = (code: number) => {
          clearTimeout(timer);
          resolve(code);
        };
        const waiters = pendingCardExits.get(cardId) ?? [];
        waiters.push(onExit);
        pendingCardExits.set(cardId, waiters);
      });
      return exitCode === null ? spawnResult : { ...spawnResult, exited: true, exitCode };
    }

    if (req.cmd === "spawn_card") {
      const validKinds: SpawnCardKind[] = ["files", "changes", "sticky", "browser", "remote-window", "task"];
      if (!req.kind || !validKinds.includes(req.kind as SpawnCardKind)) {
        return { ok: false, error: `kind must be one of ${validKinds.join(", ")}` };
      }
      // Pendentes #188 ("spawn_card por coordenadas") — validated here, not
      // just by mcp-server.ts's zod schema: acbridge talks to this bus
      // directly over the socket, no zod in that path at all (same reason
      // write_sticky's `mode` is re-checked here too).
      const validSides = ["left", "right", "top", "bottom"] as const;
      if (req.side !== undefined && !validSides.includes(req.side)) {
        return { ok: false, error: `side must be one of ${validSides.join(", ")}` };
      }
      if (req.anchorCardId !== undefined && !callbacks.listCards().some((c) => c.id === req.anchorCardId)) {
        return { ok: false, error: `no open card with id "${req.anchorCardId}"` };
      }
      const requesterId = req.requesterId ?? "";
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
      // A task card is a singleton per board. This main-process check makes
      // an MCP/acbridge request reuse the live queue immediately, without a
      // needless consent dialog. The anchor is a useful fallback for a
      // caller that names no card; the renderer repeats the guard at the
      // actual creation point to cover two requests approved concurrently.
      const taskBoardId = requesterBoardId ?? (req.anchorCardId ? callbacks.getCardBoardId(req.anchorCardId) : undefined);
      if (req.kind === "task" && taskBoardId) {
        const taskDecision = decideTaskCardSpawn(callbacks.listCardsForBoard(taskBoardId), taskBoardId);
        if (taskDecision.action === "reuse") return { ok: true, cardId: taskDecision.cardId };
      }
      if (req.kind === "browser" && req.url) {
        const spawnUrlError = navigationUrlError(req.url);
        if (spawnUrlError) return { ok: false, error: spawnUrlError };
      }
      const requestId = randomUUID();
      // DESIGN-BACKLOG.md item 60, peça 5 — same board-scoped auto-approve
      // as `open` above.
      const autonomous = requesterBoardId ? callbacks.isBoardAutonomous(requesterBoardId) : false;
      // Ideia registrada no sticky "Ideias/Brainstorm" (192), verificada e
      // aplicada 2026-09-06 — `spawn_card` de uma sticky é a MESMA classe
      // de risco de `write_sticky` (já sem gate humano nenhum): reversível
      // com um clique, sem side-effect de disco ou de processo (ao
      // contrário de `browser`/`remote-window`/`files`/`changes`, que
      // abrem uma página real, um processo remoto, ou expõem o
      // filesystem). Numa sessão remota sem humano no PC, o modal de
      // consentimento simplesmente trava o agente pra sempre nesse caso —
      // isentar só `sticky`, isolado dos outros kinds, que continuam
      // exigindo o modal normalmente fora de um board autônomo.
      const autoApprove = autonomous || req.kind === "sticky";
      markWaiting(requesterId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSpawnCards.delete(requestId);
          unmarkWaiting(requesterId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, SPAWN_TIMEOUT_MS);
        pendingSpawnCards.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingSpawnCards.delete(requestId);
            unmarkWaiting(requesterId);
            resolve(result);
          },
          timer,
        });
        callbacks.onSpawnCardRequest(requestId, requesterId, {
          kind: req.kind as SpawnCardKind,
          cwd: req.cwd,
          url: req.url,
          reason: req.reason,
          autoApprove,
          anchorCardId: req.anchorCardId,
          side: req.anchorCardId ? (req.side ?? "right") : undefined,
        });
      });
    }

    return { ok: false, error: `unknown cmd "${(req as { cmd?: string }).cmd}"` };
  }

  function resolveOpen(requestId: string, allowed: boolean, cardId?: string) {
    pendingOpens.get(requestId)?.resolve(allowed, cardId);
  }

  function resolveCloseCard(requestId: string, allowed: boolean) {
    pendingCloseCards.get(requestId)?.resolve(allowed);
  }

  function resolveSnapshot(requestId: string, result: SnapshotResult) {
    pendingSnapshots.get(requestId)?.resolve(result);
  }

  function resolvePageText(requestId: string, result: PageTextResult) {
    pendingPageTexts.get(requestId)?.resolve(result);
  }

  function resolveReadCard(requestId: string, result: ReadCardResult) {
    pendingReadCards.get(requestId)?.resolve(result);
  }

  function resolveSticky(requestId: string, result: StickyResult) {
    pendingStickyOps.get(requestId)?.resolve(result);
  }

  function resolveSpawnAgent(requestId: string, result: SpawnAgentResult) {
    pendingSpawnAgents.get(requestId)?.resolve(result);
  }

  /** DESIGN-BACKLOG.md §2.1 "SINAL 2", achado de review adversarial
   * (achado 3, MÉDIO) — a versão anterior avisava o spawner pra QUALQUER
   * card sem report, mesmo um "card de apoio" que nunca deveria chamar
   * `report` (um `files`/`browser` spawnado só pra olhar algo, ou um
   * `bash` — opção real de `provider` do próprio `spawn_agent`, mas sem
   * MCP/conceito de relatório nenhum, mesma convenção "bash não é
   * agente" de `countRunningAgentsOnBoard`). Ruído aqui é pior que
   * silêncio: um orquestrador que aprende a ignorar o aviso porque ele
   * dispara sempre para de confiar nele exatamente no caso real.
   *
   * Qualificação escolhida — DUAS fontes independentes de "havia
   * trabalho esperado", OR entre elas:
   * (a) TASK VINCULADA — existe uma task (qualquer status, não só
   *     `running`) cujo `card_id` é este card. A própria existência do
   *     vínculo já é o sinal mais forte de que alguém esperava um
   *     resultado estruturado dele.
   * (b) LINHAGEM DE AGENTE — o card foi spawnado por um `spawn_agent`
   *     bem-sucedido (`cardSpawnDepth` só é populado ali, nunca por
   *     `spawn_card`/`open_url`/um humano abrindo um terminal à mão —
   *     ver o comentário da própria `cardSpawnDepth`) E não é `bash`
   *     (excluído via `getAnyCard`, que alcança um card mesmo fora do
   *     board carregado). O contrato de `spawn_agent` pressupõe um
   *     agente capaz de eventualmente reportar; qualquer OUTRO caminho
   *     de criação nunca teve esse contrato.
   *
   * Residual conhecido, não fechado agora: se o card já foi DELETADO (não
   * só saiu — `deleteCard`, que `getAnyCard` também não alcança mais), não
   * há como checar o provider, e a qualificação (b) por padrão assume
   * "não é bash" (prefere avisar de mais a silenciar um caso real). */
  function cardWasExpectedToReport(cardId: string, linkedTask: TaskRow | undefined): boolean {
    if (linkedTask) return true;
    if (!cardSpawnDepth.has(cardId)) return false;
    return callbacks.getAnyCard(cardId)?.provider !== "bash";
  }

  /** DESIGN-BACKLOG.md item 58, M4 — called from pty-registry's own
   * `onExit`, unconditionally, for every card that exits (not just ones
   * with a waiter — cheap Map lookup, no-op when nothing's waiting). */
  function resolveCardExit(cardId: string, exitCode: number) {
    const waiters = pendingCardExits.get(cardId);
    if (waiters) {
      pendingCardExits.delete(cardId);
      for (const resolve of waiters) resolve(exitCode);
    }
    // DESIGN-BACKLOG.md item 60, peça 1 — a concurrency slot may have just
    // freed on this card's board; drain its queue if so. The card's row
    // (and board_id) still exists in store at this point — a process
    // exiting doesn't delete the card, only closing it does.
    const boardId = callbacks.getCardBoardId(cardId);
    if (boardId) tryDispatchQueued(boardId);
    // DESIGN-BACKLOG.md item 60, peça 4 — the OTHER failure path besides
    // an explicit `update_task({status:"failed"})`: an agent's process
    // exits having never called `report` at all. Achado ao vivo: killing
    // a card's process (`window.pty.kill`, node-pty on this platform)
    // reports `exitCode: 0` even for a signal-killed process — the exit
    // CODE isn't a reliable "it failed" signal at all, so this doesn't
    // gate on it (the doc draft assumed it would; verified live that it
    // doesn't). The real signal is simpler and more robust anyway: a task
    // still `running`, tied to exactly this card, that never got a
    // report — no report ever arriving IS the anomaly, regardless of
    // what exit code accompanied it. A report that DID arrive is not this
    // case — whatever it said is the real outcome, for whoever reads it
    // to call update_task, not this engine to guess.
    if (!callbacks.getReport(cardId)) {
      // `.find` sem filtrar por status: `cardWasExpectedToReport` (achado
      // 3) considera QUALQUER status principal vinculado como "havia
      // trabalho esperado"; só `markTaskFailed` abaixo continua exigindo
      // especificamente `running` (comportamento intocado).
      const linkedTask = callbacks.listTasks().find((t) => t.card_id === cardId);
      if (linkedTask?.status === "running") {
        markTaskFailed(linkedTask, `process exited (code ${exitCode}) without ever calling report`, "exit_without_report");
      }
      // Fechar histórico e avisar o spawner são critérios diferentes:
      // qualquer vínculo atual em task_cards fecha a participação, inclusive
      // um card secundário de review; apenas `cardWasExpectedToReport`
      // qualifica o aviso de entrega ao spawner. Card de apoio sem vínculo
      // nenhum não chama recordParticipationRound e não cria linha.
      const taskCardLinks = callbacks.listTaskCardsForCard(cardId) ?? [];
      if (taskCardLinks.length > 0) {
        callbacks.recordParticipationRound(cardId, null, Date.now());
      }
      if (cardWasExpectedToReport(cardId, linkedTask)) {
        // A qualificação do aviso continua separada de propósito: uma
        // linhagem de agente pode merecer aviso mesmo sem task_cards, mas
        // nunca cria histórico de participação por si só.
        // Fire-and-forget — ver o doc comment de `notifySpawnerOfUnreportedExit`
        // pro porquê de não ser `await`ado aqui. `.catch` explícito (achado
        // de review adversarial, achado 5): uma promise solta sem handler
        // vira `unhandledRejection` no processo inteiro se algum dia
        // rejeitar — `typeAndSubmit`/`readCardText` hoje nunca rejeitam
        // (resolvem sempre, até no timeout), mas essa garantia vive em
        // OUTRO arquivo; engolir aqui é não depender dela se um dia mudar.
        notifySpawnerOfUnreportedExit(cardId, exitCode).catch(() => {});
      }
    }
  }

  function notifyQueueChanged(boardId: string) {
    const list = spawnQueue.get(boardId) ?? [];
    callbacks.onQueueChanged(
      boardId,
      list.map((e) => ({ id: e.id, requesterId: e.requesterId, provider: e.provider, reason: e.reason, requestedAt: e.requestedAt })),
    );
  }

  function removeFromQueue(boardId: string, requestId: string) {
    const list = spawnQueue.get(boardId);
    if (!list) return;
    const idx = list.findIndex((e) => e.id === requestId);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** DESIGN-BACKLOG.md item 60, peça 1 — the actual dispatch, factored out
   * so both the direct-autonomous path and the queue-drain path share it
   * (previously inlined only in the direct path). */
  function dispatchSpawnAgentRequest(
    requestId: string,
    requesterId: string,
    params: SpawnQueueEntry["params"],
    autoApprove: boolean,
  ) {
    return new Promise<SpawnAgentResult>((resolve) => {
      markWaiting(requesterId);
      const timer = setTimeout(() => {
        pendingSpawnAgents.delete(requestId);
        unmarkWaiting(requesterId);
        resolve({ ok: false, error: "timed out waiting for a decision" });
      }, SPAWN_TIMEOUT_MS);
      pendingSpawnAgents.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          pendingSpawnAgents.delete(requestId);
          unmarkWaiting(requesterId);
          resolve(result);
        },
        timer,
      });
      callbacks.onSpawnAgentRequest(requestId, requesterId, { ...params, autoApprove });
    });
  }

  /** DESIGN-BACKLOG.md item 60, peça 1 — enqueues instead of refusing when
   * an autonomous board is at its cap; the returned promise settles either
   * when `tryDispatchQueued` later dispatches it for real, or on its own
   * timeout (queue starvation — never left stuck forever). */
  function enqueueSpawn(
    boardId: string,
    requestId: string,
    requesterId: string,
    params: SpawnQueueEntry["params"],
  ) {
    return new Promise<SpawnAgentResult>((resolveOuter) => {
      const timer = setTimeout(() => {
        removeFromQueue(boardId, requestId);
        notifyQueueChanged(boardId);
        resolveOuter({ ok: false, error: "queued spawn timed out waiting for a free slot" });
      }, DEFAULT_QUEUE_TIMEOUT_MS);
      const entry: SpawnQueueEntry = {
        id: requestId,
        requesterId,
        provider: params.provider,
        reason: params.reason,
        requestedAt: Date.now(),
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          resolveOuter(result);
        },
        params,
      };
      const list = spawnQueue.get(boardId) ?? [];
      list.push(entry);
      spawnQueue.set(boardId, list);
      notifyQueueChanged(boardId);
    });
  }

  /** DESIGN-BACKLOG.md item 60, peça 1 — called whenever a slot might have
   * freed (currently only from resolveCardExit above). No-op if the
   * queue's empty or the board's still at/over cap. FIFO: always the
   * oldest entry next. */
  function tryDispatchQueued(boardId: string) {
    const list = spawnQueue.get(boardId);
    if (!list || list.length === 0) return;
    const cap = callbacks.getBoardConcurrencyCap(boardId) ?? DEFAULT_CONCURRENCY_CAP;
    const running = callbacks.countRunningAgentsOnBoard(boardId);
    if (running >= cap) return;
    const entry = list.shift()!;
    notifyQueueChanged(boardId);
    dispatchSpawnAgentRequest(entry.id, entry.requesterId, entry.params, true).then(entry.resolve);
  }

  /** DESIGN-BACKLOG.md item 60, peça 3 — the one entry point BOTH
   * `spawn_agent`'s autonomous branch and the task-dispatch engine below
   * use: cap check, then either straight dispatch or `enqueueSpawn`.
   * Nothing bypasses the cap/queue, whichever path asked for the spawn. */
  function autonomousSpawn(
    boardId: string,
    requestId: string,
    requesterId: string,
    params: SpawnQueueEntry["params"],
  ) {
    const running = callbacks.countRunningAgentsOnBoard(boardId);
    const cap = callbacks.getBoardConcurrencyCap(boardId) ?? DEFAULT_CONCURRENCY_CAP;
    if (running >= cap) return enqueueSpawn(boardId, requestId, requesterId, params);
    return dispatchSpawnAgentRequest(requestId, requesterId, params, true);
  }

  /** DESIGN-BACKLOG.md item 60, peça 3 — called whenever a task reaches
   * `done` (never `failed` — a dependent shouldn't start on top of a
   * failed prerequisite; peça 4's auto-retry is what would eventually
   * flip it back to `done`). Finds every OTHER pending task whose
   * `deps_json` names this one, and for each whose OWN deps are now all
   * satisfied, auto-dispatches it — but only if that task's OWN board
   * opted into autonomous mode; every other task is left untouched,
   * exactly as before this engine existed (pure bookkeeping, an external
   * orchestrator's problem). Depth is NOT tracked here — this is engine-
   * initiated dispatch, never an agent asking to spawn another, so
   * MAX_SPAWN_DEPTH's fork-bomb guard doesn't apply; the task DAG's own
   * size is what bounds this. */
  function onTaskDone(taskId: string) {
    const allTasks = callbacks.listTasks();
    for (const task of allTasks) {
      if (task.status !== "pending" || !task.board_id) continue;
      const deps: string[] = task.deps_json ? JSON.parse(task.deps_json) : [];
      if (!deps.includes(taskId)) continue;
      if (!callbacks.isBoardAutonomous(task.board_id)) continue;
      const allDone = deps.every((depId) => allTasks.find((t) => t.id === depId)?.status === "done");
      if (!allDone) continue;
      const requestId = randomUUID();
      const params = {
        provider: task.provider ?? "claude",
        // Task's own cwd when set; `undefined` keeps App.tsx's
        // `cwd || activeBoardCwd` board-root fallback (declared, not
        // a hardcoded omission). See task-dispatch-decision.ts.
        cwd: resolveTaskDispatchCwd(task.cwd),
        resumeId: undefined,
        depth: 0,
        reason: `auto-dispatch: task ${task.id} (deps satisfied)`,
        model: undefined,
        label: resolveTaskDispatchLabel(task),
      };
      // Mark `running` right away (not after the promise settles) so a
      // second, near-simultaneous `onTaskDone` call for a sibling dep
      // can't also see this task as still `pending` and dispatch it
      // twice — same race this guards against as `markWaiting`'s ref-
      // count elsewhere in this file.
      //
      // Decisão 8 / review adversarial achado 1 — the store may HOLD this
      // write when a human locked the dependent. Spawning after a held
      // upsert is the decorative-lock bug: observe `statusChanged`
      // before `autonomousSpawn`. Divergence is already signaled.
      const decision = callbacks.upsertTask({ ...task, status: "running", updated_at: Date.now(), actor: "app" });
      if (!decision.statusChanged) continue;
      autonomousSpawn(task.board_id, requestId, "", params).then((result) => {
        if (result.ok) {
          callbacks.upsertTask({ ...task, status: "running", card_id: result.cardId, updated_at: Date.now(), actor: "app" });
        } else {
          markTaskFailed(task, result.error, "spawn_failed");
        }
      });
    }
  }

  /** DESIGN-BACKLOG.md item 60, peça 4 + "Falha TIPADA" — cause is an
   * argument, never assumed. `exit_without_report` → interrompida (back
   * to "a fazer"); `retry_spawn_failed` / `spawn_failed` are their own
   * causes (also default interrompida). A task that already carries
   * `failureKind: julgada` is NEVER downgraded — the judgment survives a
   * later spawn/retry failure. */
  function markTaskFailed(task: TaskRow, error: string, source: FailureSource) {
    const existingKind = failureKindFromResultJson(task.result_json);
    const kind = resolveFailureKind(existingKind, source);
    const write = decideFailureWrite(kind);
    const next: TaskRow = {
      ...task,
      status: write.status,
      result_json: stampFailureKindJson(task.result_json, write.failureKind, error),
      updated_at: Date.now(),
      actor: "app",
    };
    const decision = callbacks.upsertTask(next);
    if (!decision.statusChanged) return;
    retryOrFail({ ...next, status: decision.status });
  }

  /** DESIGN-BACKLOG.md item 60, peça 4 — called on a task that just
   * became `failed`. Bookkeeping-only outside an autonomous board (same
   * boundary as peça 3's onTaskDone) — an external orchestrator's own
   * retry loop is untouched there. Inside one: reassigns to the next
   * untried provider in `fallback_providers_json` (the multi-provider
   * thesis the audit actually argued for — flagged live by a reviewing
   * agent that the first pass only ever retried the SAME provider,
   * which didn't really deliver on that thesis), falling back to
   * retrying the original provider when no fallback list was given
   * (unchanged old behavior) or once the list is exhausted. Reuses
   * `autonomousSpawn` (same cap/queue as every other spawn) up to
   * `max_retries` (default DEFAULT_MAX_RETRIES) — past that, the task
   * stays `failed` for good, no infinite loop. A retry that itself fails
   * to spawn recurses back into `markTaskFailed`, bounded by the same
   * `retry_count` check — each recursion increments it, so this always
   * terminates. */
  function retryOrFail(task: TaskRow) {
    if (!task.board_id || !callbacks.isBoardAutonomous(task.board_id)) return;
    const maxRetries = task.max_retries ?? DEFAULT_MAX_RETRIES;
    if (task.retry_count >= maxRetries) return;
    const attempted: string[] = task.attempted_providers_json ? JSON.parse(task.attempted_providers_json) : [];
    const fallbackProviders: string[] = task.fallback_providers_json ? JSON.parse(task.fallback_providers_json) : [];
    const provider = fallbackProviders.find((p) => !attempted.includes(p)) ?? task.provider ?? "claude";
    attempted.push(provider);
    const requestId = randomUUID();
    const params = {
      provider,
      cwd: resolveTaskDispatchCwd(task.cwd),
      resumeId: undefined,
      depth: 0,
      reason: `auto-retry: task ${task.id} (tentativa ${task.retry_count + 1} de ${maxRetries})`,
      model: undefined,
      label: resolveTaskDispatchLabel(task),
    };
    const retrying: TaskRow = {
      ...task,
      status: "running",
      retry_count: task.retry_count + 1,
      attempted_providers_json: JSON.stringify(attempted),
      updated_at: Date.now(),
      actor: "app",
    };
    // Same class as onTaskDone/markTaskFailed: do not spawn if the store
    // held the transition back to `running` under a human lock.
    const decision = callbacks.upsertTask(retrying);
    if (!decision.statusChanged) return;
    autonomousSpawn(task.board_id, requestId, "", params).then((result) => {
      if (result.ok) {
        callbacks.upsertTask({ ...retrying, card_id: result.cardId, updated_at: Date.now(), actor: "app" });
      } else {
        markTaskFailed(retrying, result.error, "retry_spawn_failed");
      }
    });
  }

  function resolveSpawnCard(requestId: string, result: SpawnCardResult) {
    pendingSpawnCards.get(requestId)?.resolve(result);
  }

  // allowHalfOpen: true — acbridge writes its request then immediately
  // calls socket.end() (half-closing its write side) while it waits to read
  // the reply. Node's default (false) would make the server echo that FIN
  // and fully close its own side right away, killing an "open" request
  // (which deliberately holds the socket for as long as the human takes to
  // decide) before resolveOpen() ever gets to write the reply.
  const server: Server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // Pre-release audit B3 — used to be `buf = ""` after taking just the
      // FIRST line, silently discarding any bytes past the first `\n` in
      // this same chunk. `acbridge` only ever writes one line per
      // connection today, so this was unreachable in practice, but it's a
      // real correctness bug in the parser itself — collect every
      // complete line actually present in the chunk (`buf.slice(nl + 1)`
      // keeps the remainder instead of dropping it), dispatch all of
      // them, and reply with one JSON-line response per request, in
      // order, before closing.
      const lines: string[] = [];
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (lines.length === 0) return;
      Promise.all(
        lines.map((line): Promise<unknown> => {
          let req: BusRequest;
          try {
            req = JSON.parse(line);
          } catch {
            return Promise.resolve({ ok: false, error: "invalid json" });
          }
          return handleRequest(req);
        }),
      ).then((results) => {
        socket.end(results.map((r) => JSON.stringify(r)).join("\n") + "\n");
      });
    });
  });
  // Without this, a bind failure (stale non-socket file at sockPath, a
  // second instance already holding it — see AGENTS.md's dev+packaged
  // sharing the same userData note, or an overlong path) is an unhandled
  // `error` event on a Node EventEmitter, which Node rethrows as an
  // uncaught exception — crashing the ENTIRE main process (confirmed live:
  // "Uncaught Exception: Error: listen EINVAL ..." took down PTYs, the
  // board, everything, not just acbridge). Only acbridge messaging needs
  // this socket; failing to bind it should never be fatal to the rest of
  // the app.
  // Achado ao vivo (Pop!_OS, 2026-09-09, ponto seguinte do coordenador) —
  // provado com repro standalone (node -e, fora deste arquivo) antes de
  // implementar: bindar um `net.createServer()` sobre um `sockPath` já
  // ocupado falha com EADDRINUSE tanto quando há alguém VIVO escutando lá
  // quanto quando é um arquivo órfão de um shutdown sujo (socket morto ou
  // até um arquivo comum) — o código do erro sozinho NÃO distingue os dois
  // casos. O que distingue é tentar `connect()` nesse mesmo path depois:
  // `ECONNREFUSED` quando não tem ninguém do outro lado (seguro apagar e
  // rebindar), conexão aceita quando tem uma instância viva de verdade
  // (nunca apagar, nunca tentar rebindar — é exatamente o unlink cego que
  // causava o bug original, incluindo a variante dev-apaga-o-socket-do-
  // -packaged documentada no comentário da entrada desta função).
  // `bindRetried` garante no máximo UMA tentativa de rebind — sem isso, um
  // EADDRINUSE persistente (ex. a sonda de conexão também falhando por
  // outro motivo, ou uma corrida onde outra instância rebinda de novo entre
  // o unlink e o `listen` daqui) viraria um loop infinito de unlink/listen.
  let bindRetried = false;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && !bindRetried) {
      bindRetried = true;
      // Achado 2 (review adversarial, 2026-09-09) — baseline pra checar de
      // novo logo antes do unlink no branch ECONNREFUSED abaixo. Sem isto,
      // duas instâncias subindo ao mesmo tempo sobre o MESMO socket órfão
      // tomam ECONNREFUSED as duas; se a primeira já apagou+rebindou antes
      // da segunda chegar no `unlinkSync`, a segunda apagaria o socket VIVO
      // da primeira. `null` (path já não existia quando o EADDRINUSE
      // chegou — improvável mas possível) é tratado como "sem base pra
      // provar que nada mudou", o mesmo jeito conservador do branch abaixo.
      let statAtProbeTime: SockIdentity | null = null;
      try {
        const st = statSync(sockPath);
        statAtProbeTime = { dev: st.dev, ino: st.ino };
      } catch {
        // Nada em sockPath agora — segue sem baseline.
      }
      const probe = createConnection(sockPath);
      probe.on("connect", () => {
        probe.end();
        console.error("message-bus: outro processo já escuta em", sockPath, "— acbridge desta instância fica indisponível (sem rebind, sem unlink).");
        try {
          callbacks.notifyBusUnavailable(`outro processo já escuta em ${sockPath}`);
        } catch {
          // Nunca deixar o próprio aviso derrubar o processo — mesma
          // garantia documentada abaixo pro bind em si.
        }
      });
      probe.on("error", (probeErr: NodeJS.ErrnoException) => {
        if (probeErr.code === "ECONNREFUSED") {
          // Ninguém do outro lado — socket órfão (ou arquivo comum, mesmo
          // tratamento: o comentário antigo desta função já cobria "stale
          // socket from an unclean previous shutdown", só que incondicional
          // demais).
          //
          // Achado 2 (review adversarial, 2026-09-09) — antes de apagar,
          // reconfirma que o path ainda é o MESMO arquivo sondado
          // (`statAtProbeTime`). Mitiga, não elimina, a corrida entre duas
          // instâncias sondando o mesmo órfão ao mesmo tempo: não existe
          // "unlink condicionado a inode" atômico em POSIX/Node, então
          // ainda sobra uma janela (bem menor) entre ESTE segundo stat e o
          // `unlinkSync` logo abaixo onde uma 3ª instância poderia entrar.
          // Aceito conscientemente — ver a resposta ao coordenador sobre a
          // alternativa considerada (bind num path temporário + rename
          // atômico sobre o alvo) e por que não foi essa a escolha aqui.
          let currentStat: SockIdentity | null = null;
          try {
            const st2 = statSync(sockPath);
            currentStat = { dev: st2.dev, ino: st2.ino };
          } catch {
            // Sumiu de novo entre os dois stats — outra instância deve
            // estar no meio do próprio dance dela agora mesmo.
          }
          if (!sameSockIdentity(statAtProbeTime, currentStat)) {
            console.error(
              "message-bus:",
              sockPath,
              "mudou entre a sonda e o unlink — outra instância deve ter assumido o path; não apago, não rebindo.",
            );
            try {
              callbacks.notifyBusUnavailable(`${sockPath} mudou entre a sonda e o unlink — outra instância assumiu o path`);
            } catch {
              // Idem — nunca derruba o processo.
            }
            return;
          }
          try {
            unlinkSync(sockPath);
          } catch {
            // Já sumiu — outra corrida qualquer resolveu antes da gente.
          }
          server.listen(sockPath);
        } else {
          console.error("message-bus: sonda de conexão em", sockPath, "falhou com", probeErr.code, "— não sei se é seguro remover, então não removo.");
          try {
            callbacks.notifyBusUnavailable(String(probeErr));
          } catch {
            // Idem — nunca derruba o processo.
          }
        }
      });
      return;
    }
    console.error("message-bus: failed to bind, acbridge will be unavailable:", err);
    try {
      callbacks.notifyBusUnavailable(String(err));
    } catch {
      // Nunca deixar o próprio aviso de indisponibilidade derrubar o
      // processo — mesma garantia documentada acima pro bind em si.
    }
  });
  // Bug real relatado (Pop!_OS, 2026-09-09) — o `close()` abaixo fazia
  // `unlinkSync(sockPath)` cego, sem checar se o arquivo no path ainda era
  // o socket deste server. Sequência confirmada: 2ª instância sobe (sem
  // `app.requestSingleInstanceLock()` em index.ts, na época), unlinka o
  // sock da 1ª (viva) na entrada de `createMessageBus` (linha acima),
  // binda o seu, a janela da 2ª fecha, `close()` roda e unlinka de novo —
  // a 1ª instância sobrevive com o server escutando num inode sem nome
  // nenhum no filesystem, e o Stop hook do Claude Code (`acbridge
  // turn-complete`) passa a falhar com ENOENT mesmo com o processo do
  // Stellar vivo. `index.ts` agora recusa a 2ª instância antes de chegar
  // aqui, mas esta guarda fica como segunda linha de defesa: só sabemos
  // que o socket é NOSSO se o dev+ino do path, checado no exato momento em
  // que o bind terminou (`listening`), ainda bater com o que está lá na
  // hora de fechar.
  let ownSockStat: SockIdentity | null = null;
  server.on("listening", () => {
    try {
      const st = statSync(sockPath);
      ownSockStat = { dev: st.dev, ino: st.ino };
    } catch {
      // Entre o listen() e este callback o arquivo já pode ter sumido de
      // novo (outro processo disputando o mesmo path) — sem stat aqui,
      // `close()` simplesmente não vai conseguir provar posse depois, e
      // por segurança não vai remover nada.
    }
  });
  server.listen(sockPath);

  function close() {
    for (const { timer } of pendingOpens.values()) clearTimeout(timer);
    pendingOpens.clear();
    for (const { timer } of pendingCloseCards.values()) clearTimeout(timer);
    pendingCloseCards.clear();
    for (const { timer } of pendingSnapshots.values()) clearTimeout(timer);
    pendingSnapshots.clear();
    for (const { timer } of pendingPageTexts.values()) clearTimeout(timer);
    pendingPageTexts.clear();
    for (const { timer } of pendingReadCards.values()) clearTimeout(timer);
    pendingReadCards.clear();
    for (const { timer } of pendingStickyOps.values()) clearTimeout(timer);
    pendingStickyOps.clear();
    pendingCardExits.clear();
    waitingOnConsent.clear();
    // DESIGN-BACKLOG.md §2.1 — `cardReports` (o `Map` em memória) morreu
    // com esta tarefa; o slot em si agora vive no SQLite (`ReportRow`,
    // store.ts) e NÃO é limpo aqui — `close()` derruba o socket/timers
    // deste bus, não apaga histórico persistido. `pendingReportWaiters`
    // continua em memória de propósito (ver o comentário grande acima de
    // `reportSeqCounter`) — waiters de UMA execução, corretamente
    // descartados quando o bus derruba.
    pendingReportWaiters.clear();
    lastReportNotifyAt.clear();
    for (const { timer } of pendingSpawnAgents.values()) clearTimeout(timer);
    pendingSpawnAgents.clear();
    for (const { timer } of pendingSpawnCards.values()) clearTimeout(timer);
    pendingSpawnCards.clear();
    for (const list of spawnQueue.values()) for (const { timer } of list) clearTimeout(timer);
    spawnQueue.clear();
    clearInterval(idleWatchTimer);
    previousIdleState.clear();
    // Bug real relatado (Pop!_OS, 2026-09-09) — descoberta ao escrever o
    // teste desta guarda: `server.close()` ELE MESMO já faz um unlink cego
    // do que estiver em `sockPath` como parte da limpeza do bind AF_UNIX no
    // libuv, ANTES de qualquer checagem nossa depois dele rodar (confirmado
    // empiricamente: `server.close()` removeu até um arquivo comum que
    // tinha substituído o socket original). Um guard de dev/ino só DEPOIS
    // do `close()`, como este arquivo tinha antes, chega tarde demais — o
    // dano já foi feito por dentro do próprio Node. Por isso a checagem
    // roda ANTES: se o path não for mais o nosso (outra instância já
    // rebindou por cima), o que está lá é retirado do caminho (rename
    // atômico, mesmo filesystem) antes do `close()`, e devolvido depois —
    // o unlink interno do libuv passa a mirar um path vazio (sem efeito)
    // em vez do arquivo de outra instância viva.
    //
    // Achado 1 (review adversarial, 2026-09-09, severidade alta) — a
    // versão anterior comparava `st` contra `ownSockStat` mesmo quando
    // `ownSockStat` era `null` (esta instância NUNCA chegou a bindar —
    // exatamente o caso de uma instância de dev que toma EADDRINUSE porque
    // o app empacotado está vivo e dono do socket). `isOurs` dava `false`
    // por vacuidade, e o rename dance MOVIA O SOCKET VIVO DA OUTRA
    // INSTÂNCIA pra `.foreign-<uuid>` — durante a janela do dance, todo
    // `acbridge` da instância viva toma ENOENT (o bug reportado, causado
    // pelo próprio código escrito pra consertá-lo); se este processo morre
    // no meio do dance (SIGINT/crash/kill), o rename de volta nunca roda e
    // o bug fica PERMANENTE. A correção original tratava `ownSockStat ===
    // null` só como "nunca bindei" — errado, ver o achado seguinte.
    //
    // Achado seguinte (review adversarial, 2026-09-09, medido antes de
    // implementar — repro standalone, `node -e`, fora deste arquivo):
    // `ownSockStat` só é preenchido dentro do handler de `"listening"`, que
    // o Node dispara via um `process.nextTick` interno agendado DURANTE a
    // chamada síncrona de `server.listen()`. Medição: logo depois que
    // `server.listen(sockPath)` RETORNA, no MESMO tick síncrono — antes de
    // qualquer `nextTick`/`setImmediate`/`setTimeout` rodar — `server
    // .listening` já é `true` e o arquivo do socket já existe de verdade no
    // disco, mas o evento `"listening"` ainda não disparou. Ou seja: se
    // algo chamar `close()` sincronamente logo depois que
    // `createMessageBus()` retorna (sem `await` no meio — o padrão comum
    // de `index.ts`), essa instância JÁ bindou de verdade mas
    // `ownSockStat` ainda é `null`. Não é uma corrida rara — é uma janela
    // garantida em TODO bind bem-sucedido.
    //
    // A pergunta certa, portanto, não é "eu sei qual é o meu socket?"
    // (`ownSockStat`) sozinha — é duas perguntas separadas: "eu bindei?"
    // (`server.listening`, o getter síncrono do próprio Node, sempre
    // correto no instante em que `close()` roda) e, só se a resposta for
    // sim, "eu sei QUAL arquivo é o meu?" (`ownSockStat`). Três
    // combinações:
    //   1. `!server.listening` — nunca bindei (ou já não estou bindado).
    //      Nada pra proteger, `close()` não toca no filesystem.
    //   2. `server.listening && ownSockStat !== null` — bindei e sei qual é
    //      o meu. Dance de sempre: só move se o arquivo no path não for o
    //      meu.
    //   3. `server.listening && ownSockStat === null` — a janela nova:
    //      bindei de verdade, mas ainda não capturei qual arquivo é o meu.
    //      Sem baseline pra provar nada, ai postura conservadora: PROTEGE
    //      de qualquer forma, mesmo sem prova — o dance roda incondicional.
    //      Consequência aceita: se o arquivo no path era mesmo o nosso, o
    //      rename de volta (o mesmo bloco de restauração que já existe pro
    //      caso 2, logo depois do `server.close()`) devolve ele pro NOME
    //      original — só que agora como um socket comum órfão (ninguém
    //      mais escuta nele, este processo já fechou). Isso é
    //      autocurável: a sonda de EADDRINUSE da PRÓXIMA inicialização
    //      (deste ou de outro processo) o acha exatamente em `sockPath`,
    //      toma ECONNREFUSED contra ele, apaga e rebinda. Órfão que se
    //      cura sozinho é estritamente melhor que apagar o socket vivo de
    //      uma instância que não era esta.
    // Achado (review adversarial, 2026-09-09, encontrado ESCREVENDO o teste
    // do achado seguinte, não pedido diretamente) — a versão anterior fazia
    // o "park" com `renameSync(sockPath, parked)`, que REMOVE o nome
    // original imediatamente, deixando `sockPath` VAZIO pela duração
    // INTEIRA de "park → server.close() → restaura" — uma janela sob
    // controle nosso, maior do que precisa ser, durante a qual uma
    // instância B poderia bindar em `sockPath`. Pior: `server.close()`
    // ELE MESMO já faz um unlink incondicional de QUALQUER COISA que
    // esteja em `sockPath` no momento em que roda (achado bem mais antigo
    // deste arquivo) — então se B bindar nessa janela ampliada, é o
    // PRÓPRIO `server.close()` que destrói o socket de B, ANTES da nossa
    // restauração sequer rodar; nenhuma escolha de primitiva no passo de
    // restauração evita isso, porque o estrago já foi feito mais cedo.
    //
    // Provado com repro standalone (`node -e`, fora deste arquivo, antes de
    // implementar): trocar o park de `renameSync` (destrutivo, remove o
    // nome original na hora) por `linkSync` (cria um SEGUNDO nome pro
    // MESMO inode, sem tocar no original) elimina essa janela auto-
    // infligida por completo — `sockPath` continua com o conteúdo original
    // até o exato instante em que `server.close()` o remove por conta
    // própria (o mesmo instante que já existiria de qualquer forma, pra
    // QUALQUER server AF_UNIX fechando, com ou sem este código). Depois
    // disso, sobra só a janela residual mínima entre o retorno de
    // `server.close()` e a chamada de restauração logo abaixo — a MESMA
    // janela, curtíssima, que o `linkSync`-com-EEXIST da restauração já
    // protege (ver o comentário grande no bloco de restauração).
    let parkedForeignPath: string | null = null;
    // Junto de `parkedForeignPath`, registra QUAL combinação estacionou o
    // arquivo: decide, lá embaixo, o que fazer com ele se a restauração não
    // puder devolvê-lo ao nome original (ver o comentário grande antes do
    // `linkSync` de restauração).
    //   - Combinação 2: sabemos, por `ownSockStat`, que o arquivo NÃO é
    //     nosso — é de outra instância qualquer.
    //   - Combinação 3: não temos prova nenhuma — pode ser nosso.
    let parkedMightBeOurs = false;
    if (server.listening) {
      if (ownSockStat !== null) {
        // Combinação 2.
        try {
          const st = statSync(sockPath);
          const isOurs = sameSockIdentity(ownSockStat, { dev: st.dev, ino: st.ino });
          if (!isOurs) {
            parkedForeignPath = `${sockPath}.foreign-${randomUUID()}`;
            linkSync(sockPath, parkedForeignPath);
            parkedMightBeOurs = false;
          }
        } catch {
          // Nada em sockPath (ENOENT) — nada pra proteger, `close()` não
          // tem o que apagar. Ou o `linkSync` falhou por outro motivo —
          // segue sem backup, mesma postura conservadora de sempre.
        }
      } else {
        // Combinação 3 — bindei, mas sem baseline ainda. Protege sem
        // condição nenhuma, mesmo sem prova de que era necessário: o
        // bloco de restauração logo abaixo tenta devolver este arquivo pro
        // NOME original (`sockPath`) depois do `server.close()` — de
        // propósito, é isso que permite o autocura: se o arquivo era mesmo
        // nosso, ele volta a existir em `sockPath` como um socket comum
        // órfão (ninguém mais escutando nele), e a sonda de EADDRINUSE da
        // PRÓXIMA inicialização o acha exatamente lá, toma ECONNREFUSED e
        // limpa sozinha — ver o comentário grande acima.
        try {
          parkedForeignPath = `${sockPath}.foreign-${randomUUID()}`;
          linkSync(sockPath, parkedForeignPath);
          parkedMightBeOurs = true;
        } catch {
          // Nada em sockPath, ou `linkSync` falhou por outro motivo — nada
          // mais a fazer aqui.
        }
      }
    }
    server.close();
    if (parkedForeignPath) {
      // Achado (review adversarial, 2026-09-09, severidade média) — esta
      // restauração usava `renameSync(parkedForeignPath, sockPath)`, que
      // sobrescreve incondicionalmente (`rename()` POSIX clobbera o
      // destino se existir). Combinado com o park antigo (`renameSync` no
      // bloco acima, que já deixou de existir — ver o comentário grande
      // logo antes de `parkedForeignPath` ser declarado), a janela em que
      // uma instância B podia bindar em `sockPath` e ser destruída por
      // esta restauração cobria o `server.close()` inteiro. Encolhida a
      // janela do lado do park (via `linkSync` não-destrutivo), ainda sobra
      // uma janela residual mínima aqui — entre `server.close()` retornar
      // e esta restauração rodar — e é ESTA restauração, não o park, que
      // precisa ser à prova de sobrescrever o que quer que tenha aparecido
      // nesse intervalo.
      //
      // Provado com repro standalone (`node -e`, fora deste arquivo,
      // rodado antes de implementar) antes de escolher a primitiva:
      //   (a) `linkSync` cria um segundo nome apontando pro MESMO inode de
      //       um arquivo de socket AF_UNIX — funciona, o socket original
      //       não perde nada.
      //   (b) se `sockPath` já existe (B assumiu), `linkSync` FALHA com
      //       `EEXIST` em vez de sobrescrever — é o "crie este nome, mas
      //       nunca substitua" atômico do POSIX, ao contrário de `rename`.
      //   (c) o nome restaurado via `linkSync` continua servindo `connect()`
      //       normalmente — não é um link "morto", é o mesmo socket vivo
      //       sob o nome de volta.
      // `if (!existsSync(sockPath))` antes de um `rename` (a sugestão
      // original do reviewer) foi descartado por ser TOCTOU — só encurta a
      // janela entre o check e o rename, não fecha. `linkSync` não tem essa
      // janela: o próprio kernel recusa o `link()` atomicamente se o nome
      // já existir.
      try {
        linkSync(parkedForeignPath, sockPath);
        // Sucesso: `sockPath` agora é um segundo nome pro mesmo inode do
        // arquivo estacionado. Remove o nome temporário — o arquivo
        // continua vivo através do link novo criado em `sockPath`.
        unlinkSync(parkedForeignPath);
      } catch (linkErr) {
        const code = (linkErr as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          // Alguém assumiu `sockPath` durante a janela — exatamente o
          // cenário que o `linkSync` existe pra recusar. O que fazer com
          // `parkedForeignPath` agora depende de QUEM ele era
          // (`parkedMightBeOurs`, registrado lá em cima):
          if (parkedMightBeOurs) {
            // Combinação 3: não tínhamos prova de que não era nosso — e
            // agora que ninguém mais vai reclamar dele (já fechamos),
            // apagar é só limpeza. Mesmo raciocínio do autocura acima,
            // adiantado: em vez de deixar um `.foreign-*` órfão pra
            // sempre, remove direto.
            try {
              unlinkSync(parkedForeignPath);
            } catch {
              // Já sumiu — tudo bem.
            }
          } else {
            // Combinação 2: SABÍAMOS que não era nosso — é de uma terceira
            // instância (nem esta, nem a B que assumiu o path agora).
            // Apagar destruiria dado alheio sem necessidade nenhuma;
            // deixa o `.foreign-*` no diretório em vez de arriscar.
            console.error(
              "message-bus: outra instância assumiu",
              sockPath,
              "antes da restauração — preservando o arquivo estacionado em",
              parkedForeignPath,
              "em vez de apagar (não era nosso).",
            );
          }
        } else {
          // Erro de `link()` que não é EEXIST (ex. cross-device, embora
          // `parkedForeignPath` esteja sempre no mesmo diretório de
          // `sockPath`) — mesma cautela do resto do arquivo: loga, não
          // arrisca mexer em mais nada.
          console.error("message-bus: falha inesperada restaurando", sockPath, "de", parkedForeignPath, ":", linkErr);
        }
      }
    }
  }

  /** Sticky item "Fila de concorrência quebrada", achado 1 (2026-09-03) —
   * `tryDispatchQueued` só era chamado de `resolveCardExit`, nunca quando
   * um slot "libera" por outro motivo: subir `concurrency_cap` num board
   * com fila nunca reavaliava nada, a request ficava presa até o timeout
   * de 10min (`DEFAULT_QUEUE_TIMEOUT_MS`) mesmo com capacidade de sobra.
   * Fina camada pública só pra isso — `index.ts` chama depois de persistir
   * um cap novo, mesmo padrão de "avisa o motor, não deixa ele confiar só
   * em polling" que o resto deste arquivo já usa. */
  function notifyConcurrencyCapChanged(boardId: string) {
    tryDispatchQueued(boardId);
  }

  return {
    handleRequest,
    resolveOpen,
    resolveCloseCard,
    resolveSnapshot,
    resolvePageText,
    resolveReadCard,
    resolveSticky,
    resolveSpawnAgent,
    resolveSpawnCard,
    resolveCardExit,
    notifyConcurrencyCapChanged,
    notifyHumanMovedTask,
    close,
  };
}
