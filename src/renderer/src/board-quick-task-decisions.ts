/**
 * Board quick-task (screen 15) — pure decisions: destination, kind, selection
 * → contract context, local/team create bodies, and Ctrl+K command matching.
 */

import type { TeamTaskKindInfo } from "../../preload/index";
import type { TaskDestination, TeamTaskFormState } from "./team-task-form-decisions";
import { emptyTaskForm, toLocalPrompt, toTeamTaskBody } from "./team-task-form-decisions";

export type QuickTaskKind = Extract<TeamTaskKindInfo, "investigar" | "implementar" | "corrigir" | "medir">;

export const QUICK_KINDS: readonly QuickTaskKind[] = ["investigar", "implementar", "corrigir", "medir"];

export type QuickTaskState = {
  title: string;
  kind: QuickTaskKind;
  destination: TaskDestination;
  territory: string[];
  contract: string;
};

export type SelectionCardLite = {
  id: string;
  kind: string;
  label: string;
  cwd: string | null;
};

export type BoardCmdId =
  | "new-board"
  | "new-team"
  | "distribute"
  | "import"
  | "selection-to-task"
  | "open-by-id";

export type BoardCmd = {
  id: BoardCmdId;
  /** Matching tokens (query is lowercased). */
  tokens: string[];
};

/** Prototype order: Distribuir and Importar before Transformar. */
export const BOARD_TASK_COMMANDS: readonly BoardCmd[] = [
  { id: "new-board", tokens: ["nova task", "neste board", "new task", "board", "task", "tasks"] },
  { id: "new-team", tokens: ["nova task", "time", "team", "board do time", "task", "tasks"] },
  { id: "distribute", tokens: ["distribuir", "sem dono", "unassigned", "task", "tasks"] },
  { id: "import", tokens: ["importar", "import", "slack", "linear", "jira", "github", "task", "tasks"] },
  { id: "selection-to-task", tokens: ["seleção", "selection", "transformar", "cards", "task", "tasks"] },
  { id: "open-by-id", tokens: ["abrir", "open", "#"] },
];

export function emptyQuickTask(destination: TaskDestination = "board"): QuickTaskState {
  return {
    title: "",
    kind: "corrigir",
    destination,
    territory: [],
    contract: "",
  };
}

/** Names and cwd only — never terminal scrollback. */
export function selectionToContractContext(cards: readonly SelectionCardLite[]): string {
  if (cards.length === 0) return "";
  const lines = ["Contexto da seleção:"];
  for (const card of cards) {
    const name = card.label.trim() || card.kind;
    if (card.cwd) lines.push(`- ${name} (${card.kind}) · cwd ${card.cwd}`);
    else lines.push(`- ${name} (${card.kind})`);
  }
  return lines.join("\n");
}

/** Suggest territory globs from open files-card paths (basename dirs). */
export function suggestedTerritory(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const p = raw.trim().replace(/\\/g, "/");
    if (!p) continue;
    const parts = p.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const idx = parts.findIndex((x) => x === "src" || x === "scripts" || x === "tests");
    const base = idx >= 0 ? parts.slice(idx, idx + 2).join("/") : parts[parts.length - 1]!;
    const glob = base.includes(".") ? parts.slice(0, -1).slice(-2).join("/") + "/**" : `${base}/**`;
    if (glob && !out.includes(glob)) out.push(glob);
    if (out.length >= 3) break;
  }
  return out;
}

export function quickToFormState(quick: QuickTaskState): TeamTaskFormState {
  return {
    ...emptyTaskForm(),
    destination: quick.destination,
    title: quick.title,
    kind: quick.kind,
    territory: [...quick.territory],
    contract: quick.contract,
    assignment: quick.destination === "team" ? "open" : "open",
  };
}

export function quickLocalPrompt(quick: QuickTaskState): string {
  return toLocalPrompt(quickToFormState(quick));
}

export function quickTeamBody(quick: QuickTaskState): Record<string, unknown> {
  return toTeamTaskBody(quickToFormState(quick));
}

export function canSubmitQuick(quick: QuickTaskState): boolean {
  return quick.title.trim() !== "";
}

/** Count team tasks in `sem_dono` for the Distribuir row. */
export function countUnassignedTeamTasks(tasks: readonly { state?: string }[]): number {
  return tasks.filter((t) => t.state === "sem_dono").length;
}

/** Filter Ctrl+K commands; a leading #N prefers open-by-id. */
export function filterBoardCommands(query: string): BoardCmd[] {
  const q = query.trim().toLowerCase();
  if (q.startsWith("#") || /^#?\d{4,}/.test(q) || /^[0-9a-f]{8}/i.test(q.trim())) {
    return BOARD_TASK_COMMANDS.filter((c) => c.id === "open-by-id");
  }
  if (q === "") return [...BOARD_TASK_COMMANDS];
  return BOARD_TASK_COMMANDS.filter((c) => c.tokens.some((t) => t.includes(q) || q.includes(t)));
}

/**
 * Ctrl+K rows visible for the current account mode.
 * Without a cloud account, team/import/distribute disappear. With an account
 * but no connected team, Distribuir still disappears (prototype).
 */
export function visibleBoardCommands(
  query: string,
  opts: { teamConnected: boolean; hasCloudAccount: boolean },
): BoardCmd[] {
  const cmds = filterBoardCommands(query);
  if (!opts.hasCloudAccount) {
    return cmds.filter((c) => c.id !== "new-team" && c.id !== "distribute" && c.id !== "import");
  }
  if (opts.teamConnected) return cmds;
  return cmds.filter((c) => c.id !== "distribute");
}

/** Match a task by #shortId, full uuid prefix, or title substring. */
export function matchTaskByQuery<T extends { id: string; prompt: string }>(
  query: string,
  tasks: readonly T[],
): T | null {
  const q = query.trim().replace(/^#/, "").toLowerCase();
  if (!q) return null;
  const byId = tasks.find((t) => t.id.toLowerCase().startsWith(q) || t.id.replace(/-/g, "").toLowerCase().startsWith(q));
  if (byId) return byId;
  const short = q.slice(0, 8);
  const byShort = tasks.find((t) => t.id.replace(/-/g, "").toLowerCase().startsWith(short) || t.id.toLowerCase().startsWith(short));
  if (byShort) return byShort;
  return tasks.find((t) => t.prompt.toLowerCase().includes(q)) ?? null;
}

/** sessionStorage key: open team board filtered to unassigned after goHome. */
export const TEAM_BOARD_FOCUS_KEY = "stellar.teamBoardFocus";

export type TeamBoardFocus = { teamId: string; unassigned: boolean };

export function writeTeamBoardFocus(focus: TeamBoardFocus): void {
  try {
    sessionStorage.setItem(TEAM_BOARD_FOCUS_KEY, JSON.stringify(focus));
  } catch {
    /* ignore */
  }
}

export function consumeTeamBoardFocus(): TeamBoardFocus | null {
  try {
    const raw = sessionStorage.getItem(TEAM_BOARD_FOCUS_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(TEAM_BOARD_FOCUS_KEY);
    const parsed = JSON.parse(raw) as TeamBoardFocus;
    if (!parsed?.teamId) return null;
    return { teamId: parsed.teamId, unassigned: !!parsed.unassigned };
  } catch {
    return null;
  }
}
