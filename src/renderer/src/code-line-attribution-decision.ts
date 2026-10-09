/**
 * Maps editor lines to a live card/task using only facts the app already
 * has (captured hunks + card accent). No invented authorship.
 */

export type AgentLineHunk = {
  /** Inclusive 1-based line range in the working tree file. */
  fromLine: number;
  toLine: number;
  cardId: string;
  /** Card accent used for the gutter strip (from the live card). */
  color: string;
  label: string | null;
  taskId: string | null;
  taskTitle: string | null;
  /** Epoch-ms of the evidence (diff capture / last write), when known. */
  at: number | null;
};

export type AgentLineMark = {
  line: number;
  cardId: string;
  color: string;
  label: string | null;
  taskId: string | null;
  taskTitle: string | null;
  at: number | null;
  fromLine: number;
  toLine: number;
};

/**
 * Expands hunks into per-line marks. When two hunks cover the same line,
 * the later `at` wins; equal/`null` keeps the first — disputed coverage
 * is not invented beyond what the caller passed.
 */
export function decideAgentLineMarks(hunks: readonly AgentLineHunk[]): Map<number, AgentLineMark> {
  const out = new Map<number, AgentLineMark>();
  for (const h of hunks) {
    if (h.toLine < h.fromLine) continue;
    for (let line = h.fromLine; line <= h.toLine; line++) {
      const prev = out.get(line);
      const next: AgentLineMark = {
        line,
        cardId: h.cardId,
        color: h.color,
        label: h.label,
        taskId: h.taskId,
        taskTitle: h.taskTitle,
        at: h.at,
        fromLine: h.fromLine,
        toLine: h.toLine,
      };
      if (!prev) {
        out.set(line, next);
        continue;
      }
      const prevAt = prev.at ?? -1;
      const nextAt = h.at ?? -1;
      if (nextAt >= prevAt) out.set(line, next);
    }
  }
  return out;
}
