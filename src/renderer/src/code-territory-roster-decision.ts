/**
 * Build the "agents in this folder" roster from live board facts only.
 * Territory comes from the task contract; running = live implementer link.
 */

import type { TerritoryAgent } from "./code-territory-warn-decision";

export type RosterTaskFact = {
  id: string;
  status: string;
  cardAlive: boolean;
  /** Declared territory paths; null/empty = undeclared (NORMAL). */
  territory: readonly string[] | null;
  cards: readonly {
    cardId: string;
    role: string;
    label: string | null;
    orphan: boolean;
  }[];
};

export type RosterCardColor = {
  cardId: string;
  /** Accent hex already resolved from the live card's provider. */
  color: string;
};

const DEAD = new Set(["done", "failed", "superseded"]);

/**
 * One entry per live implementer card that declared territory. Idle or
 * orphan links are omitted — inventing "running" from git alone is refused.
 */
export function decideTerritoryRoster(
  tasks: readonly RosterTaskFact[],
  colors: readonly RosterCardColor[] = [],
): TerritoryAgent[] {
  const colorById = new Map(colors.map((c) => [c.cardId, c.color]));
  const byCard = new Map<string, TerritoryAgent & { color?: string }>();

  for (const task of tasks) {
    if (DEAD.has(task.status)) continue;
    const territory = (task.territory ?? []).filter((p) => p.trim() !== "");
    if (territory.length === 0) continue;
    for (const link of task.cards) {
      if (link.role !== "implementer") continue;
      if (link.orphan) continue;
      const running = task.cardAlive && !DEAD.has(task.status);
      const prev = byCard.get(link.cardId);
      if (prev) {
        const merged = new Set([...prev.territory, ...territory]);
        byCard.set(link.cardId, {
          ...prev,
          running: prev.running || running,
          territory: [...merged],
          label: prev.label ?? link.label,
        });
      } else {
        byCard.set(link.cardId, {
          cardId: link.cardId,
          label: link.label,
          territory,
          running,
          color: colorById.get(link.cardId),
        });
      }
    }
  }

  return [...byCard.values()].map(({ color: _c, ...agent }) => agent);
}

/** Relative path → accent of a running agent whose territory covers it. */
export function decideAgentDotByPath(
  agents: readonly TerritoryAgent[],
  colors: readonly RosterCardColor[],
  filePaths: readonly string[],
  pathInTerritory: (file: string, pattern: string) => boolean,
): Record<string, string> {
  const colorById = new Map(colors.map((c) => [c.cardId, c.color]));
  const out: Record<string, string> = {};
  for (const file of filePaths) {
    for (const a of agents) {
      if (!a.running) continue;
      if (!a.territory.some((p) => pathInTerritory(file, p))) continue;
      const color = colorById.get(a.cardId);
      if (color) {
        out[file] = color;
        break;
      }
    }
  }
  return out;
}
