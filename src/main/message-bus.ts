import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TaskRow, ConnectorRow } from "./store";

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
export type CardSummary = { id: string; kind: string; provider: string; cwd: string; label: string | null; url?: string };
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
export type SpawnCardKind = "files" | "changes" | "sticky" | "browser" | "remote-window";
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
  | { cmd: "report"; requesterId?: string; report?: unknown }
  | { cmd: "get_report"; target?: string; wait?: boolean; timeoutMs?: number }
  | {
      cmd: "create_task";
      prompt?: string;
      provider?: string;
      cardId?: string;
      boardId?: string;
      deps?: string[];
      maxRetries?: number;
      fallbackProviders?: string[];
    }
  | {
      cmd: "update_task";
      taskId?: string;
      status?: string;
      cardId?: string | null;
      result?: unknown;
      incrementRetry?: boolean;
      attemptedProvider?: string;
    }
  | { cmd: "list_tasks" }
  | { cmd: "get_task"; taskId?: string }
  | { cmd: "list_connectors" }
  | { cmd: "set_connector_kind"; connectorId?: string; kind?: string | null }
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
       * error. `undefined` for every provider that ignores it. */
      effort?: "low" | "high";
      /** DESIGN-BACKLOG.md item 62 — same free-text label a human sets via
       * CardTag rename; `describeCardLabel`/the renderer's `describeCard`
       * already prefer it over the "Bash 2°" ordinal when present. */
      label?: string;
      wait?: boolean;
      waitTimeoutMs?: number;
    }
  | { cmd: "spawn_card"; kind?: string; cwd?: string; url?: string; requesterId?: string; reason?: string };

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
    onAutoConnect: (fromCardId: string, toCardId: string, kind: string) => void;
    /** DESIGN-BACKLOG.md item 58, M4 — pty-registry.ts's own `isAlive`,
     * threaded straight through: no round trip needed, main already knows. */
    isCardAlive: (cardId: string) => boolean;
    /** Sticky item "card_status idle" — `null` for a card with no live
     * PTY entry (never spawned/exited/error), matching `isCardAlive`'s
     * own "no entry" convention. */
    getCardLastActivityAt: (cardId: string) => number | null;
    /** Sticky item "card_status idle" (fix ao vivo, 2026-09-04) — OS
     * notification, never touches any terminal's PTY/input. See the doc
     * comment on `notifySpawnerOfIdleCard` above for why `writeToCard`
     * was wrong here. `idleThresholdMs` is passed through purely for the
     * notification body text, not used for any timing decision here. */
    notifyIdleCard: (spawnerId: string, idleCardLabel: string, idleThresholdMs: number) => void;
    /** Prototipo (2026-09-06) — ver o comentário de `turn_complete` no
     * `BusRequest` acima. Push fire-and-forget pro renderer, keyed pelo
     * mesmo id unificado card/PTY (pty-registry.ts); `useTerminal.ts`
     * escuta e, só pro provider `claude`, usa isto como o sinal
     * DEFINITIVO de fim de turno em vez do timer de silêncio de 900ms. */
    notifyTurnComplete: (cardId: string) => void;
    /** DESIGN-BACKLOG.md item 59 — which board a card lives on, and
     * whether that board's opt-in autonomous mode is on. Only ever read
     * here, never written — the only write path is a human's toggle in
     * the UI (App.tsx's session UI → `setBoardAutonomous`), never an
     * MCP/acbridge cmd (see AGENTS.md's architecture entry). */
    getCardBoardId: (cardId: string) => string | undefined;
    isBoardAutonomous: (boardId: string) => boolean;
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
    getTask: (id: string) => TaskRow | undefined;
    upsertTask: (task: TaskRow) => void;
    /** DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 4 — data
     * model only: this exposes the connector graph and lets kind be
     * tagged on an existing connector, but nothing in this app dispatches
     * off it. Deciding WHEN a `depends` edge means "go" is left to an
     * external orchestrating agent, driving spawn_agent itself (which
     * still goes through its own human consent gate, same as ever) —
     * see AGENTS.md's positioning entry on this. */
    listAllConnectors: () => ConnectorRow[];
    setConnectorKind: (id: string, kind: string | null) => boolean;
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
         * own field above. */
        effort?: "low" | "high";
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
      },
    ) => void;
  },
) {
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      // Stale socket from an unclean previous shutdown — best effort.
    }
  }

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
  const cardReports = new Map<string, unknown>();
  const pendingReportWaiters = new Map<string, Array<(report: unknown) => void>>();
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
      effort?: "low" | "high";
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
      result: row.result_json ? JSON.parse(row.result_json) : null,
      deps: row.deps_json ? JSON.parse(row.deps_json) : [],
      retryCount: row.retry_count,
      attemptedProviders: row.attempted_providers_json ? JSON.parse(row.attempted_providers_json) : [],
      // DESIGN-BACKLOG.md item 60, peça 4 — EFFECTIVE value, same
      // "never null, resolve the fallback here" convention as
      // board_mode's concurrencyCap.
      maxRetries: row.max_retries ?? DEFAULT_MAX_RETRIES,
      fallbackProviders: row.fallback_providers_json ? JSON.parse(row.fallback_providers_json) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
  function notifySpawnerOfIdleCard(cardId: string) {
    const spawnedBy = callbacks
      .listAllConnectors()
      .filter((c) => c.kind === "spawned" && c.to_card_id === cardId)
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    if (!spawnedBy) return;
    const spawnerId = spawnedBy.from_card_id;
    if (!callbacks.isCardAlive(spawnerId)) return;
    const label = callbacks.describeCardLabel(cardId);
    callbacks.notifyIdleCard(spawnerId, label, IDLE_THRESHOLD_MS);
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
      callbacks.onAutoConnect(req.requesterId, req.target, kind);
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
      callbacks.writeToCard(target, text);
      // Regra geral de auto-conector (2026-09-02, generalizada a QUALQUER
      // interação entre cards via MCP — ver `AUTO_CONNECT_CMDS` no fim
      // deste arquivo, chamado de dentro do `handleRequest` wrapper) —
      // nada a fazer aqui, o wrapper cuida disso depois que este bloco
      // devolver `{ok:true}`.
      // DESIGN-BACKLOG.md item 58, M2 follow-up — self-verifying submit:
      // write the Enter, then read the card back (same round-trip as
      // read_card) and check whether the composer still shows an
      // un-submitted paste placeholder. If it does, retry ONLY the
      // Enter (never the text again, that would duplicate it) — bounded
      // by SEND_ENTER_MAX_ATTEMPTS so a card that's genuinely just slow
      // to render can't loop forever.
      //
      // Sticky item "send_to_card não confirma envio" (2026-09-03) —
      // the placeholder regex alone only catches ONE symptom (a CLI that
      // collapses a big paste into a "[Pasted text ...]" chip). Reported
      // live: a plain, short message just sat RAW in the input box —
      // never collapsed, so `check.text` never matched, so the loop broke
      // immediately on the very first read even though nothing was ever
      // submitted; `{ok:true}` came back with the message still unsent.
      // Second, provider-agnostic signal added: the composer's own input
      // line generally still shows the literal text it was given, until
      // it's actually submitted (whatever the CLI does after submit —
      // spinner, new prompt, echoed history line — reliably looks
      // DIFFERENT from the raw typed line). Checking for a meaningful
      // prefix of what was just written, not the whole thing (terminal
      // soft-wrap can split a long line across rows) and normalized for
      // whitespace (wrapping/redraw can turn a space into a newline).
      const sentPrefix = text.trim().replace(/\s+/g, " ").slice(0, 24);
      function looksUnsent(checkText: string): boolean {
        if (/pasted text/i.test(checkText)) return true;
        if (sentPrefix.length < 8) return false; // too short to mean anything, avoid false positives
        return checkText.replace(/\s+/g, " ").includes(sentPrefix);
      }
      for (let attempt = 0; attempt < SEND_ENTER_MAX_ATTEMPTS; attempt++) {
        await delay(SEND_ENTER_DELAY_MS);
        callbacks.writeToCard(target, "\r");
        await delay(SEND_ENTER_CONFIRM_DELAY_MS);
        const check = await readCardText(target, 8);
        // A read failure (timed out, card gone) isn't evidence the
        // submit failed — stop retrying rather than guess.
        if (!check.ok || !looksUnsent(check.text)) break;
      }
      return { ok: true };
    }

    if (req.cmd === "open") {
      if (!req.url) return { ok: false, error: "missing url" };
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
      cardReports.set(req.requesterId, req.report);
      const waiters = pendingReportWaiters.get(req.requesterId);
      if (waiters) {
        pendingReportWaiters.delete(req.requesterId);
        for (const resolve of waiters) resolve(req.report);
      }
      return { ok: true };
    }

    if (req.cmd === "get_report") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      if (cardReports.has(req.target)) return { ok: true, report: cardReports.get(req.target) };
      if (!req.wait) return { ok: false, error: "no report yet" };
      const target = req.target;
      const timeoutMs = req.timeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const waiters = pendingReportWaiters.get(target);
          if (waiters) {
            const idx = waiters.indexOf(onReport);
            if (idx !== -1) waiters.splice(idx, 1);
            if (waiters.length === 0) pendingReportWaiters.delete(target);
          }
          resolve({ ok: false, error: "timed out waiting for report" });
        }, timeoutMs);
        const onReport = (report: unknown) => {
          clearTimeout(timer);
          resolve({ ok: true, report });
        };
        const waiters = pendingReportWaiters.get(target) ?? [];
        waiters.push(onReport);
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
      callbacks.upsertTask({
        id,
        prompt: req.prompt ?? null,
        provider: req.provider ?? null,
        status: req.cardId ? "running" : "pending",
        card_id: req.cardId ?? null,
        board_id: boardId,
        result_json: null,
        deps_json: req.deps ? JSON.stringify(req.deps) : null,
        retry_count: 0,
        attempted_providers_json: req.provider ? JSON.stringify([req.provider]) : null,
        max_retries: req.maxRetries ?? null,
        fallback_providers_json: req.fallbackProviders ? JSON.stringify(req.fallbackProviders) : null,
        created_at: now,
        updated_at: now,
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
      const updated: TaskRow = {
        ...existing,
        status: req.status ?? existing.status,
        card_id: req.cardId !== undefined ? req.cardId : existing.card_id,
        result_json: req.result !== undefined ? JSON.stringify(req.result) : existing.result_json,
        retry_count: existing.retry_count + (req.incrementRetry ? 1 : 0),
        attempted_providers_json: attemptedProviders.length > 0 ? JSON.stringify(attemptedProviders) : existing.attempted_providers_json,
        updated_at: Date.now(),
      };
      callbacks.upsertTask(updated);
      // DESIGN-BACKLOG.md item 60, peça 3 — a task reaching `done` may
      // unblock dependents; check right after persisting, using the NEW
      // status (existing.status is stale by now). Never on `failed` — a
      // dependent shouldn't start on top of a failed prerequisite.
      if (req.status === "done" && existing.status !== "done") onTaskDone(req.taskId);
      // DESIGN-BACKLOG.md item 60, peça 4 — a task reaching `failed` may
      // be eligible for auto-retry (bookkeeping-only outside an
      // autonomous board — retryOrFail itself checks that).
      if (req.status === "failed" && existing.status !== "failed") retryOrFail(updated);
      return { ok: true };
    }

    if (req.cmd === "list_tasks") {
      return { ok: true, tasks: callbacks.listTasks().map(serializeTask) };
    }

    if (req.cmd === "get_task") {
      if (!req.taskId) return { ok: false, error: "missing taskId" };
      const task = callbacks.getTask(req.taskId);
      if (!task) return { ok: false, error: `no such task "${req.taskId}"` };
      return { ok: true, task: serializeTask(task) };
    }

    if (req.cmd === "list_connectors") {
      return {
        ok: true,
        connectors: callbacks.listAllConnectors().map((c) => ({
          id: c.id,
          fromCardId: c.from_card_id,
          toCardId: c.to_card_id,
          kind: c.kind,
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
      const found = callbacks.setConnectorKind(req.connectorId, req.kind ?? null);
      if (!found) return { ok: false, error: `no such connector "${req.connectorId}"` };
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
      const validKinds: SpawnCardKind[] = ["files", "changes", "sticky", "browser", "remote-window"];
      if (!req.kind || !validKinds.includes(req.kind as SpawnCardKind)) {
        return { ok: false, error: `kind must be one of ${validKinds.join(", ")}` };
      }
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      // DESIGN-BACKLOG.md item 60, peça 5 — same board-scoped auto-approve
      // as `open` above.
      const requesterBoardId = callbacks.getCardBoardId(requesterId);
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
    if (!cardReports.has(cardId)) {
      const task = callbacks.listTasks().find((t) => t.card_id === cardId && t.status === "running");
      if (task) markTaskFailed(task, `process exited (code ${exitCode}) without ever calling report`);
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
        cwd: undefined,
        resumeId: undefined,
        depth: 0,
        reason: `auto-dispatch: task ${task.id} (deps satisfied)`,
        model: undefined,
      };
      // Mark `running` right away (not after the promise settles) so a
      // second, near-simultaneous `onTaskDone` call for a sibling dep
      // can't also see this task as still `pending` and dispatch it
      // twice — same race this guards against as `markWaiting`'s ref-
      // count elsewhere in this file.
      callbacks.upsertTask({ ...task, status: "running", updated_at: Date.now() });
      autonomousSpawn(task.board_id, requestId, "", params).then((result) => {
        if (result.ok) {
          callbacks.upsertTask({ ...task, status: "running", card_id: result.cardId, updated_at: Date.now() });
        } else {
          markTaskFailed(task, result.error);
        }
      });
    }
  }

  /** DESIGN-BACKLOG.md item 60, peça 4 — marks a task `failed` and,
   * unless bookkeeping-only (no board, or board not autonomous),
   * immediately tries `retryOrFail` on it. Single choke point so every
   * path that can fail a task (explicit `update_task`, onTaskDone's own
   * spawn failure, a card exiting silently below) gets the same
   * auto-retry treatment. */
  function markTaskFailed(task: TaskRow, error: string) {
    const failed: TaskRow = { ...task, status: "failed", result_json: JSON.stringify({ error }), updated_at: Date.now() };
    callbacks.upsertTask(failed);
    retryOrFail(failed);
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
      cwd: undefined,
      resumeId: undefined,
      depth: 0,
      reason: `auto-retry: task ${task.id} (tentativa ${task.retry_count + 1} de ${maxRetries})`,
      model: undefined,
    };
    const retrying: TaskRow = {
      ...task,
      status: "running",
      retry_count: task.retry_count + 1,
      attempted_providers_json: JSON.stringify(attempted),
      updated_at: Date.now(),
    };
    callbacks.upsertTask(retrying);
    autonomousSpawn(task.board_id, requestId, "", params).then((result) => {
      if (result.ok) {
        callbacks.upsertTask({ ...retrying, card_id: result.cardId, updated_at: Date.now() });
      } else {
        markTaskFailed(retrying, result.error);
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
  server.on("error", (err) => {
    console.error("message-bus: failed to bind, acbridge will be unavailable:", err);
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
    cardReports.clear();
    pendingReportWaiters.clear();
    for (const { timer } of pendingSpawnAgents.values()) clearTimeout(timer);
    pendingSpawnAgents.clear();
    for (const { timer } of pendingSpawnCards.values()) clearTimeout(timer);
    pendingSpawnCards.clear();
    for (const list of spawnQueue.values()) for (const { timer } of list) clearTimeout(timer);
    spawnQueue.clear();
    clearInterval(idleWatchTimer);
    previousIdleState.clear();
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      // Already gone — fine.
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
    close,
  };
}
