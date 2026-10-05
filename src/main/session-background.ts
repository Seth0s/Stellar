/**
 * Pure decisions for background sessions: the configurable ceiling on how many
 * sessions may stay alive in the background, and the projection the Home reads
 * to say, per session, what is still running.
 *
 * The ceiling only WARNS; nothing here terminates anything.
 */

/** 4. */
export const DEFAULT_MAX_BACKGROUND_SESSIONS = 4;

export function resolveMaxBackgroundSessions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STELLAR_MAX_BACKGROUND_SESSIONS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_BACKGROUND_SESSIONS;
  return Math.floor(raw);
}

/** Facts the consumer (index.ts) measures from the registry/store, per board. */
export type BoardBackgroundFact = {
  boardId: string;
  /** A live PTY exists on this board (terminal, bash included). */
  alive: boolean;
  /** Live agent cards (terminal != bash) — "how many are running". */
  agents: number;
  /** Live cards waiting on a human decision — "waiting on you". */
  awaiting: number;
};

export type BoardBackgroundEntry = {
  alive: boolean;
  agents: number;
  awaiting: number;
};

export type BackgroundStatus = {
  boards: Record<string, BoardBackgroundEntry>;
  /** Live sessions that are NOT the one currently on screen. */
  backgroundCount: number;
  maxBackgroundSessions: number;
  overCap: boolean;
};

/**
 * "Live background session" = has a live process AND is not the open one. The
 * Home reads `boards[id]` per saved session; `overCap` is the warning (the UI
 * decides how to show it), never an order to stop anything.
 */
export function computeBackgroundStatus(
  facts: BoardBackgroundFact[],
  activeBoardId: string | null,
  maxBackgroundSessions: number,
): BackgroundStatus {
  const boards: Record<string, BoardBackgroundEntry> = {};
  let backgroundCount = 0;
  for (const f of facts) {
    boards[f.boardId] = { alive: f.alive, agents: f.agents, awaiting: f.awaiting };
    if (f.alive && f.boardId !== activeBoardId) backgroundCount += 1;
  }
  return {
    boards,
    backgroundCount,
    maxBackgroundSessions,
    overCap: backgroundCount > maxBackgroundSessions,
  };
}

/**
 * A `pty:kill` arriving from the UI unmount (the renderer left the board) must
 * not terminate a RETAINED card — that is exactly what "the session stays
 * alive" means. An EXPLICIT stop (`board:stop`, app close) does not go through
 * here: it clears `retained` before killing. Pure decision for the IPC handler.
 */
export function decideUnmountKill(retained: boolean): "skip" | "kill" {
  return retained ? "skip" : "kill";
}

/**
 * "Stop session" with an agent running requires confirmation; without one it
 * is immediate (no work in progress to lose). Pure: the UI asks, the actuator
 * (`board:stop`) kills only after the yes.
 */
export function decideStopSessionConfirm(liveAgents: number): boolean {
  return liveAgents > 0;
}
