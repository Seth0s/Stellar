/**
 * Copy for the agent gutter tooltip. Facts only — missing fields stay absent.
 */

import type { AgentLineMark } from "./code-line-attribution-decision";

export type GutterTooltipModel = {
  title: string;
  taskLine: string | null;
  whenLine: string | null;
};

export function decideGutterTooltip(mark: AgentLineMark, nowMs: number): GutterTooltipModel {
  const who = mark.label?.trim() || mark.cardId;
  const range =
    mark.fromLine === mark.toLine ? String(mark.fromLine) : `${mark.fromLine}–${mark.toLine}`;
  const title = `${who} · lines ${range}`;
  const taskLine =
    mark.taskId || mark.taskTitle
      ? `task ${mark.taskId ? `#${mark.taskId.slice(0, 6)}` : ""}${mark.taskTitle ? ` · ${mark.taskTitle}` : ""}`.trim()
      : null;
  let whenLine: string | null = null;
  if (mark.at != null) {
    const sec = Math.max(0, Math.floor((nowMs - mark.at) / 1000));
    if (sec < 60) whenLine = `${sec}s ago`;
    else if (sec < 3600) whenLine = `${Math.floor(sec / 60)} min ago`;
    else whenLine = `${Math.floor(sec / 3600)} h ago`;
  }
  return { title, taskLine, whenLine };
}
