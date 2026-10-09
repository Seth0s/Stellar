/**
 * Prototype Codigo.dc.html — opening a file that sits in a running agent's
 * declared territory shows a warning before the human edits. Uses only
 * declared territory paths from live task links; invents nothing.
 */

export type TerritoryAgent = {
  cardId: string;
  label: string | null;
  /** Absolute or repo-relative paths / globs declared on the task. */
  territory: readonly string[];
  /** True when the card still has a live PTY / implementer link. */
  running: boolean;
};

export type TerritoryWarnDecision =
  | { action: "allow" }
  | { action: "warn"; agents: Array<{ cardId: string; label: string | null }> };

/** Path match: exact, directory prefix, or simple `*` suffix glob. */
export function pathInTerritory(filePath: string, pattern: string): boolean {
  const file = filePath.replace(/\\/g, "/");
  const pat = pattern.replace(/\\/g, "/");
  if (!pat) return false;
  if (pat.endsWith("/**")) {
    const base = pat.slice(0, -3);
    return file === base || file.startsWith(base.endsWith("/") ? base : `${base}/`);
  }
  if (pat.includes("*")) {
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(file);
  }
  return file === pat || file.startsWith(pat.endsWith("/") ? pat : `${pat}/`);
}

/**
 * If any *running* agent declared territory covering `filePath`, warn.
 * Idle / non-running cards never block.
 */
export function decideTerritoryEditWarn(
  filePath: string,
  agents: readonly TerritoryAgent[],
): TerritoryWarnDecision {
  const hits: Array<{ cardId: string; label: string | null }> = [];
  for (const a of agents) {
    if (!a.running) continue;
    if (a.territory.some((p) => pathInTerritory(filePath, p))) {
      hits.push({ cardId: a.cardId, label: a.label });
    }
  }
  if (hits.length === 0) return { action: "allow" };
  return { action: "warn", agents: hits };
}
