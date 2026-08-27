import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

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
export type SpawnCardKind = "files" | "changes" | "sticky" | "browser" | "remote-window";
export type SpawnAgentResult = { ok: true; cardId: string } | { ok: false; error: string };
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
  | {
      cmd: "spawn_agent";
      provider?: string;
      cwd?: string;
      resumeId?: string;
      requesterId?: string;
      depth?: number;
      reason?: string;
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
    onSpawnAgentRequest: (
      requestId: string,
      requesterId: string,
      params: { provider: string; cwd?: string; resumeId?: string; depth: number; reason?: string },
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
  const pendingSpawnAgents = new Map<string, { resolve: (result: SpawnAgentResult) => void; timer: NodeJS.Timeout }>();
  const pendingSpawnCards = new Map<string, { resolve: (result: SpawnCardResult) => void; timer: NodeJS.Timeout }>();

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
      callbacks.writeToCard(req.target, (req.text ?? "") + "\r");
      return { ok: true };
    }

    if (req.cmd === "open") {
      if (!req.url) return { ok: false, error: "missing url" };
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingOpens.delete(requestId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, OPEN_TIMEOUT_MS);
        pendingOpens.set(requestId, {
          resolve: (allowed) => {
            clearTimeout(timer);
            pendingOpens.delete(requestId);
            resolve(allowed ? { ok: true } : { ok: false, error: "denied by user" });
          },
          timer,
        });
        callbacks.onOpenRequest(requestId, req.requesterId ?? "", req.url as string, req.reason);
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

    if (req.cmd === "spawn_agent") {
      if (!req.provider) return { ok: false, error: "missing provider" };
      const depth = req.depth ?? 0;
      if (depth >= MAX_SPAWN_DEPTH) {
        return { ok: false, error: `spawn depth limit reached (max ${MAX_SPAWN_DEPTH}) — refusing to spawn another agent` };
      }
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSpawnAgents.delete(requestId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, SPAWN_TIMEOUT_MS);
        pendingSpawnAgents.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingSpawnAgents.delete(requestId);
            resolve(result);
          },
          timer,
        });
        callbacks.onSpawnAgentRequest(requestId, req.requesterId ?? "", {
          provider: req.provider as string,
          cwd: req.cwd,
          resumeId: req.resumeId,
          depth: depth + 1,
          reason: req.reason,
        });
      });
    }

    if (req.cmd === "spawn_card") {
      const validKinds: SpawnCardKind[] = ["files", "changes", "sticky", "browser", "remote-window"];
      if (!req.kind || !validKinds.includes(req.kind as SpawnCardKind)) {
        return { ok: false, error: `kind must be one of ${validKinds.join(", ")}` };
      }
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSpawnCards.delete(requestId);
          resolve({ ok: false, error: "timed out waiting for a decision" });
        }, SPAWN_TIMEOUT_MS);
        pendingSpawnCards.set(requestId, {
          resolve: (result) => {
            clearTimeout(timer);
            pendingSpawnCards.delete(requestId);
            resolve(result);
          },
          timer,
        });
        callbacks.onSpawnCardRequest(requestId, req.requesterId ?? "", {
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

  function resolveSpawnAgent(requestId: string, result: SpawnAgentResult) {
    pendingSpawnAgents.get(requestId)?.resolve(result);
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

  return { handleRequest, resolveOpen, resolveSnapshot, resolvePageText, resolveSpawnAgent, resolveSpawnCard, close };
}
