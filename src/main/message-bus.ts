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
// reliably the same way a human pressing Enter after a paste does.
const SEND_ENTER_DELAY_MS = 80;
// DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 1 — same
// reasoning as DEFAULT_WAIT_EXIT_TIMEOUT_MS: waiting for a real agent's
// real result is not a bug-detection backstop, it's the actual point.
const DEFAULT_REPORT_TIMEOUT_MS = 600_000;

// DESIGN-BACKLOG.md item 21, ponto 9, achado 1 — an agent spawning another
// agent, which spawns another... with zero guard, is an unbounded fork
// bomb. `depth` travels with every spawned process's env
// (AGENT_CANVAS_SPAWN_DEPTH, see pty-registry.ts) and increments by 1 on
// every agent-initiated (not human-initiated) spawn; a human spawning
// from the rail/radial menu always starts a fresh chain at depth 0. This
// is a hard cap enforced BEFORE any consent modal even shows — asking a
// human to approve something structurally disallowed is just noise.
export const MAX_SPAWN_DEPTH = 3;

export type CardSummary = { id: string; provider: string; cwd: string };
export type SnapshotResult = { ok: true; path: string } | { ok: false; error: string };
export type PageTextResult = { ok: true; text: string; truncated: boolean } | { ok: false; error: string };
export type ReadCardResult = { ok: true; text: string } | { ok: false; error: string };
export type CardStatusResult = { ok: true; status: "running" | "waiting" | "exited" } | { ok: false; error: string };
export type SpawnCardKind = "files" | "changes" | "sticky" | "browser" | "remote-window";
export type SpawnAgentResult =
  | { ok: true; cardId: string; exited?: boolean; exitCode?: number }
  | { ok: false; error: string };
export type SpawnCardResult = { ok: true; cardId: string } | { ok: false; error: string };

export type BusRequest =
  | { cmd: "list" }
  | { cmd: "send"; target?: string; text?: string }
  | { cmd: "open"; url?: string; requesterId?: string; reason?: string }
  | {
      cmd: "snapshot";
      target?: string;
      rect?: { x: number; y: number; w: number; h: number };
    }
  | { cmd: "get_page_text"; target?: string }
  | { cmd: "read_card"; target?: string; lines?: number }
  | { cmd: "card_status"; target?: string }
  | { cmd: "report"; requesterId?: string; report?: unknown }
  | { cmd: "get_report"; target?: string; wait?: boolean; timeoutMs?: number }
  | { cmd: "create_task"; prompt?: string; provider?: string; cardId?: string; deps?: string[] }
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
  | {
      cmd: "spawn_agent";
      provider?: string;
      cwd?: string;
      resumeId?: string;
      requesterId?: string;
      depth?: number;
      reason?: string;
      model?: string;
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
    /** `reason` — DESIGN-BACKLOG.md item 21, ponto 9, "motivo" in the
     * generic ask-permission component: only ever set by an MCP tool call
     * (a real, typed, optional param there); acbridge's CLI never sets it
     * (would need an awkward extra positional arg) — the consent modal
     * just shows nothing for that line when absent. */
    onOpenRequest: (requestId: string, requesterId: string, url: string, reason?: string) => void;
    /** cardId set: that card's current on-screen rect. rect set: an
     * explicit world-space rect. Neither: the whole window. Resolving
     * either into actual capturePage() screen pixels lives in
     * main/index.ts — this module only relays the parsed request. */
    onSnapshotRequest: (
      requestId: string,
      target: { cardId: string } | { rect: { x: number; y: number; w: number; h: number } } | null,
    ) => void;
    /** No consent gate (see PAGE_TEXT_TIMEOUT_MS) — reads an already-open
     * browser card's rendered text, same risk class as `snapshot`. */
    onPageTextRequest: (requestId: string, cardId: string) => void;
    /** DESIGN-BACKLOG.md item 58, M1 — only the renderer holds the live
     * xterm.js Terminal instance for a terminal card (main never sees
     * terminal content, only raw pty bytes flowing through). */
    onReadCardRequest: (requestId: string, cardId: string, lines?: number) => void;
    /** DESIGN-BACKLOG.md item 58, M4 — pty-registry.ts's own `isAlive`,
     * threaded straight through: no round trip needed, main already knows. */
    isCardAlive: (cardId: string) => boolean;
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
      params: { provider: string; cwd?: string; resumeId?: string; depth: number; reason?: string; model?: string },
    ) => void;
    onSpawnCardRequest: (
      requestId: string,
      requesterId: string,
      params: { kind: SpawnCardKind; cwd?: string; url?: string; reason?: string },
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

  const pendingOpens = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();
  const pendingSnapshots = new Map<string, { resolve: (result: SnapshotResult) => void; timer: NodeJS.Timeout }>();
  const pendingPageTexts = new Map<string, { resolve: (result: PageTextResult) => void; timer: NodeJS.Timeout }>();
  const pendingReadCards = new Map<string, { resolve: (result: ReadCardResult) => void; timer: NodeJS.Timeout }>();
  // DESIGN-BACKLOG.md item 58, M4 — waiters for `spawn_agent`'s
  // `wait: true`, keyed by the spawned card's id. Several waiters could in
  // principle exist for the same card (two callers both waiting on it),
  // so each entry is a list, not a single resolver.
  const pendingCardExits = new Map<string, Array<(exitCode: number) => void>>();
  // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 1 — a
  // dedicated result channel, decoupled from process exit (an agent might
  // report a result and keep running, e.g. an interactive session): the
  // last report a card sent (for a caller polling after the fact) plus
  // waiters for one still pending (same shape as pendingCardExits above).
  const cardReports = new Map<string, unknown>();
  const pendingReportWaiters = new Map<string, Array<(report: unknown) => void>>();
  const pendingSpawnAgents = new Map<string, { resolve: (result: SpawnAgentResult) => void; timer: NodeJS.Timeout }>();
  const pendingSpawnCards = new Map<string, { resolve: (result: SpawnCardResult) => void; timer: NodeJS.Timeout }>();
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
      result: row.result_json ? JSON.parse(row.result_json) : null,
      deps: row.deps_json ? JSON.parse(row.deps_json) : [],
      retryCount: row.retry_count,
      attemptedProviders: row.attempted_providers_json ? JSON.parse(row.attempted_providers_json) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Shared by both frontends — see the module doc comment. Never throws;
   * every branch resolves to a `BusResponse`, including "unknown cmd". */
  async function handleRequest(req: BusRequest): Promise<BusResponse> {
    if (req.cmd === "list") {
      return { ok: true, cards: callbacks.listCards() };
    }

    if (req.cmd === "send") {
      const cards = callbacks.listCards();
      if (!req.target || !cards.some((c) => c.id === req.target)) {
        return { ok: false, error: `no open terminal card with id "${req.target}"` };
      }
      const target = req.target;
      callbacks.writeToCard(target, req.text ?? "");
      setTimeout(() => callbacks.writeToCard(target, "\r"), SEND_ENTER_DELAY_MS);
      return { ok: true };
    }

    if (req.cmd === "open") {
      if (!req.url) return { ok: false, error: "missing url" };
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      markWaiting(requesterId);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingOpens.delete(requestId);
          unmarkWaiting(requesterId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, OPEN_TIMEOUT_MS);
        pendingOpens.set(requestId, {
          resolve: (allowed) => {
            clearTimeout(timer);
            pendingOpens.delete(requestId);
            unmarkWaiting(requesterId);
            resolve(allowed ? { ok: true } : { ok: false, error: "denied by user" });
          },
          timer,
        });
        callbacks.onOpenRequest(requestId, requesterId, req.url as string, req.reason);
      });
    }

    if (req.cmd === "snapshot") {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSnapshots.delete(requestId);
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
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingReadCards.delete(requestId);
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
        callbacks.onReadCardRequest(requestId, req.target as string, req.lines);
      });
    }

    if (req.cmd === "card_status") {
      if (!req.target) return { ok: false, error: "missing target cardId" };
      const cards = callbacks.listCards();
      if (!cards.some((c) => c.id === req.target)) return { ok: false, error: `no open terminal card with id "${req.target}"` };
      // DESIGN-BACKLOG.md item 58, roteiro de orquestração peça 2 —
      // checked BEFORE isAlive: a card blocked on its own consent modal is
      // still a live process (isAlive true), but reporting "running" here
      // is exactly the ambiguity this state exists to remove.
      if (waitingOnConsent.has(req.target)) return { ok: true, status: "waiting" };
      return { ok: true, status: callbacks.isCardAlive(req.target) ? "running" : "exited" };
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
      callbacks.upsertTask({
        id,
        prompt: req.prompt ?? null,
        provider: req.provider ?? null,
        status: req.cardId ? "running" : "pending",
        card_id: req.cardId ?? null,
        result_json: null,
        deps_json: req.deps ? JSON.stringify(req.deps) : null,
        retry_count: 0,
        attempted_providers_json: req.provider ? JSON.stringify([req.provider]) : null,
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
      callbacks.upsertTask({
        ...existing,
        status: req.status ?? existing.status,
        card_id: req.cardId !== undefined ? req.cardId : existing.card_id,
        result_json: req.result !== undefined ? JSON.stringify(req.result) : existing.result_json,
        retry_count: existing.retry_count + (req.incrementRetry ? 1 : 0),
        attempted_providers_json: attemptedProviders.length > 0 ? JSON.stringify(attemptedProviders) : existing.attempted_providers_json,
        updated_at: Date.now(),
      });
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
      const validKinds = ["context", "depends", null];
      if (req.kind !== undefined && !validKinds.includes(req.kind)) {
        return { ok: false, error: `kind must be one of context, depends, or null` };
      }
      const found = callbacks.setConnectorKind(req.connectorId, req.kind ?? null);
      if (!found) return { ok: false, error: `no such connector "${req.connectorId}"` };
      return { ok: true };
    }

    if (req.cmd === "spawn_agent") {
      if (!req.provider) return { ok: false, error: "missing provider" };
      const depth = req.depth ?? 0;
      if (depth >= MAX_SPAWN_DEPTH) {
        return { ok: false, error: `spawn depth limit reached (max ${MAX_SPAWN_DEPTH}) — refusing to spawn another agent` };
      }
      const requestId = randomUUID();
      const requesterId = req.requesterId ?? "";
      markWaiting(requesterId);
      const spawnResult = await new Promise<SpawnAgentResult>((resolve) => {
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
        callbacks.onSpawnAgentRequest(requestId, requesterId, {
          provider: req.provider as string,
          cwd: req.cwd,
          resumeId: req.resumeId,
          depth: depth + 1,
          reason: req.reason,
          model: req.model,
        });
      });
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
        });
      });
    }

    return { ok: false, error: `unknown cmd "${(req as { cmd?: string }).cmd}"` };
  }

  function resolveOpen(requestId: string, allowed: boolean) {
    pendingOpens.get(requestId)?.resolve(allowed);
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

  function resolveSpawnAgent(requestId: string, result: SpawnAgentResult) {
    pendingSpawnAgents.get(requestId)?.resolve(result);
  }

  /** DESIGN-BACKLOG.md item 58, M4 — called from pty-registry's own
   * `onExit`, unconditionally, for every card that exits (not just ones
   * with a waiter — cheap Map lookup, no-op when nothing's waiting). */
  function resolveCardExit(cardId: string, exitCode: number) {
    const waiters = pendingCardExits.get(cardId);
    if (!waiters) return;
    pendingCardExits.delete(cardId);
    for (const resolve of waiters) resolve(exitCode);
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
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = "";
      let req: BusRequest;
      try {
        req = JSON.parse(line);
      } catch {
        socket.end(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
        return;
      }
      handleRequest(req).then((res) => socket.end(JSON.stringify(res) + "\n"));
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
    for (const { timer } of pendingSnapshots.values()) clearTimeout(timer);
    pendingSnapshots.clear();
    for (const { timer } of pendingPageTexts.values()) clearTimeout(timer);
    pendingPageTexts.clear();
    for (const { timer } of pendingReadCards.values()) clearTimeout(timer);
    pendingReadCards.clear();
    pendingCardExits.clear();
    waitingOnConsent.clear();
    cardReports.clear();
    pendingReportWaiters.clear();
    for (const { timer } of pendingSpawnAgents.values()) clearTimeout(timer);
    pendingSpawnAgents.clear();
    for (const { timer } of pendingSpawnCards.values()) clearTimeout(timer);
    pendingSpawnCards.clear();
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      // Already gone — fine.
    }
  }

  return { handleRequest, resolveOpen, resolveSnapshot, resolvePageText, resolveReadCard, resolveSpawnAgent, resolveSpawnCard, resolveCardExit, close };
}
