/**
 * Import from a local board — the reading side. Boards and task rows come from
 * the app's own store bridges (injected, so tests need no Electron); prompts are
 * read per task because the board payload carries only a preview.
 */

import {
  buildLocalImportRow,
  isOpenLocalStatus,
  summarizeLocalBoard,
  type LocalBoardSummary,
  type LocalImportRow,
} from "./local-board-import-decisions";

export type LocalBoardRef = { id: string; name: string };
export type LocalTaskRef = { id: string; status: string; purpose: string | null };

export type LocalImportReader = {
  listBoards: () => Promise<readonly LocalBoardRef[]>;
  listBoardTasks: (boardId: string) => Promise<readonly LocalTaskRef[]>;
  getPrompt: (taskId: string) => Promise<{ ok: true; prompt: string | null } | { ok: false; error: string }>;
};

export type LocalBoardsSnapshot = {
  summaries: LocalBoardSummary[];
  /** Open tasks only, by board id. */
  openByBoard: Map<string, LocalTaskRef[]>;
};

export async function loadLocalBoards(reader: LocalImportReader): Promise<LocalBoardsSnapshot> {
  const boards = await reader.listBoards();
  const summaries: LocalBoardSummary[] = [];
  const openByBoard = new Map<string, LocalTaskRef[]>();
  for (const board of boards) {
    const tasks = await reader.listBoardTasks(board.id);
    summaries.push(summarizeLocalBoard(board, tasks));
    openByBoard.set(
      board.id,
      tasks.filter((t) => isOpenLocalStatus(t.status)),
    );
  }
  return { summaries, openByBoard };
}

const PROMPT_READ_CONCURRENCY = 8;

export type LocalCollected = {
  rows: LocalImportRow[];
  /** Board name by external id, for the preview line of each row. */
  boardOf: Map<string, string>;
};

/**
 * Rows for the chosen boards, in board order. A task listed twice is sent once;
 * a task without any prompt text has no title and is left out.
 */
export async function collectLocalImportRows(
  reader: LocalImportReader,
  snapshot: LocalBoardsSnapshot,
  selected: ReadonlySet<string>,
): Promise<LocalCollected> {
  const queue: { task: LocalTaskRef; boardName: string }[] = [];
  const seen = new Set<string>();
  for (const summary of snapshot.summaries) {
    if (!selected.has(summary.id)) continue;
    for (const task of snapshot.openByBoard.get(summary.id) ?? []) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      queue.push({ task, boardName: summary.name });
    }
  }
  const rows: (LocalImportRow | null)[] = new Array(queue.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < queue.length) {
      const index = next++;
      const { task, boardName } = queue[index];
      const res = await reader.getPrompt(task.id);
      if (!res.ok) throw new Error(res.error);
      rows[index] = buildLocalImportRow({ id: task.id, boardName, prompt: res.prompt ?? "", purpose: task.purpose });
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROMPT_READ_CONCURRENCY, queue.length) }, () => worker()));
  const kept: LocalImportRow[] = [];
  const boardOf = new Map<string, string>();
  rows.forEach((row, index) => {
    if (!row) return;
    kept.push(row);
    boardOf.set(row.external_id, queue[index].boardName);
  });
  return { rows: kept, boardOf };
}
