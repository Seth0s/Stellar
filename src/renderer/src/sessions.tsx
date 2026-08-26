// Shared between Topbar.tsx's switcher popover and Home.tsx (DESIGN-
// BACKLOG.md item 8) — both render the same "sessions grouped by project"
// list + status dot, just at different scales/density.

export type Board = { id: string; name: string; project: string };
export type BoardCounts = { agents: number; active: number };

export const UNGROUPED_LABEL = "sem projeto";

/** Groups boards by `project`, preserving each group's first-seen order —
 * boards are already fetched ordered by created_at, so this reads as
 * "oldest project first", matching the artifact's CENTRAL/IDYPLATFORM
 * layout without a separate sort pass. */
export function groupByProject<T extends Board>(boards: T[]): [string, T[]][] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const b of boards) {
    const key = b.project || UNGROUPED_LABEL;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(b);
  }
  return order.map((k) => [k, groups.get(k)!]);
}

export function StatusDot({ counts }: { counts?: BoardCounts }) {
  const cls = !counts || counts.agents === 0 ? "" : counts.active > 0 ? "ok" : "";
  return <span className={`card-status-dot${cls ? ` ${cls}` : ""}`} />;
}
