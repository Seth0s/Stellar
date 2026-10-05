export type CloudPresence = "logged-out" | "pending" | "logged-in" | null;

/**
 * Tela 2 shows only for a profile that has no sessions, no account and never
 * made the choice. An account that is still loading (`null`) is not treated as
 * absent, so the welcome screen never flashes in front of someone logged in.
 */
export function shouldShowFirstRun(input: { decided: boolean; boardCount: number; cloud: CloudPresence }): boolean {
  if (input.decided) return false;
  if (input.boardCount > 0) return false;
  const loggedOut = input.cloud !== null && input.cloud !== "logged-in";
  return loggedOut;
}

/**
 * The session offered as "Continue": the most recently opened one. A profile
 * with a single session still gets it, since there is nothing else to open.
 */
export function pickContinueBoard<T extends { id: string; last_accessed_at: number | null }>(boards: T[]): T | null {
  let best: T | null = null;
  let bestAt = -1;
  for (const b of boards) {
    const at = b.last_accessed_at ?? 0;
    if (!best || at > bestAt) {
      best = b;
      bestAt = at;
    }
  }
  return best;
}

/** Free-text search over a session's name, project label and folder path. */
export function filterSessions<T extends { name: string; project: string; cwd: string }>(boards: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return boards;
  return boards.filter(
    (b) => b.name.toLowerCase().includes(q) || b.project.toLowerCase().includes(q) || b.cwd.toLowerCase().includes(q),
  );
}

/** The "recent" badge belongs to the most recent session, but only when there
 * is more than one — with a single session it would badge the only card. */
export function recentBadgeId<T extends { id: string; last_accessed_at: number | null }>(boards: T[]): string | null {
  if (boards.length <= 1) return null;
  return pickContinueBoard(boards)?.id ?? null;
}

/** Project groups ordered by label for the "name" sort. */
export function sortGroupsByName<T>(groups: [string, T[]][]): [string, T[]][] {
  return [...groups].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Shorten an absolute path by replacing the home prefix with `~`. */
export function abbreviateHome(path: string, homeDir: string): string {
  if (homeDir && path === homeDir) return "~";
  if (homeDir && path.startsWith(`${homeDir}/`)) return `~/${path.slice(homeDir.length + 1)}`;
  return path;
}

