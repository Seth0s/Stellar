import { useEffect, useRef, useState } from "react";
import { cascadeSlot, type WorldTransform } from "./board-model";
import type { Card, Connector } from "./card-types";
import { toast } from "./useToast";
import type { BoardCounts, BoardRow, CardRow } from "../../preload/index";

const ACTIVE_BOARD_KEY = "ac.activeBoardId";

/** Last path segment of an absolute cwd — the auto-derived `project`
 * grouping label (see createBoard/updateBoard below). */
function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

/** DESIGN-BACKLOG.md item 7 — "nenhum template de sessão... não há
 * atalho pra 'sessão com claude+bash+arquivos já arrumados'", the exact
 * setup the user's own screenshots kept showing. Add cases here (and to
 * SessionModal.tsx's picker + `seedCards` below) rather than building a
 * general template editor — one hardcoded extra option is what was asked
 * for, not a system. */
export type SessionTemplate = "empty" | "claude-bash-files";

function seedCards(defaultCwd: string, nextId: React.RefObject<number>, template: SessionTemplate): Card[] {
  const terminal = (provider: string, index: number): Card => ({
    id: String(nextId.current++),
    kind: "terminal",
    provider,
    cwd: defaultCwd,
    resumeId: null,
    continueLast: false,
    model: null,
    systemPrompt: null,
    initialInput: null,
    rect: cascadeSlot(index),
    groupId: null,
    label: null,
  });
  if (template === "claude-bash-files") {
    return [
      terminal("claude", 0),
      terminal("bash", 1),
      { id: String(nextId.current++), kind: "files", root: defaultCwd, rect: cascadeSlot(2), groupId: null, label: null },
    ];
  }
  // "Vazio" means vazio — a session reported this seeding a bash terminal
  // anyway ("eu escolhi vazio, e veio um bash feito ainda") as not working.
  // Zero cards is the correct, literal reading; the user adds whatever
  // they want from the rail.
  return [];
}

/**
 * Board CRUD + load/switch (item 5 of DESIGN-BACKLOG.md, phase 2 — hook
 * extraction out of `App.tsx`, 4/4). Owns `boards`/`activeBoardId`/
 * `boardCounts`/`loaded` — everything that only board-switching itself
 * needs. `cards`/`order`/`connectors`/`world`/`liveStatus` stay App.tsx
 * state (shared by every other hook too), so this hook takes their
 * setters as parameters, same boundary `useCardSelection` already
 * established. `toRow`/`fromRow` are passed in rather than duplicated —
 * they're the card<->CardRow serialization App.tsx already owns.
 */
export function useBoardStore(
  nextId: React.RefObject<number>,
  setCards: (v: Card[] | ((prev: Card[]) => Card[])) => void,
  setOrder: (v: string[] | ((prev: string[]) => string[])) => void,
  setConnectors: (v: Connector[] | ((prev: Connector[]) => Connector[])) => void,
  setWorld: (v: WorldTransform | ((prev: WorldTransform) => WorldTransform)) => void,
  resetLiveStatus: () => void,
  defaultCwd: string,
  toRow: (card: Card, boardId: string) => CardRow,
  fromRow: (r: CardRow) => Card,
) {
  const [loaded, setLoaded] = useState(false);
  const [boards, setBoards] = useState<BoardRow[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardCounts, setBoardCounts] = useState<Record<string, BoardCounts>>({});
  const activeBoardIdRef = useRef<string | null>(null);
  activeBoardIdRef.current = activeBoardId;

  function refreshBoardCounts() {
    void window.store.cardCounts().then(setBoardCounts);
  }

  /** Swaps the whole board in: cards/connectors of the previous board are
   * replaced wholesale, which unmounts their card components — that's what
   * actually stops a departing board's terminal PTYs/browser views (see
   * AGENTS.md, "switching boards" — no special-case cleanup code needed,
   * it's a natural consequence of the id sets no longer overlapping). A
   * board with no rows yet (brand new, or the very first launch) seeds one
   * bash terminal, same as the original single-board bootstrap did. */
  async function loadBoard(boardId: string, template: SessionTemplate = "empty", seedCwd?: string) {
    const [rows, connectorRows] = await Promise.all([
      window.store.list(boardId),
      window.store.connectors.list(boardId),
    ]);
    setConnectors(connectorRows.map((r) => ({ id: r.id, fromCardId: r.from_card_id, toCardId: r.to_card_id })));
    setWorld({ panX: 0, panY: 0, zoom: 1 });
    // Every id here belonged to the departing board — never valid for
    // whatever loads next (see App.tsx's liveStatus module comment).
    resetLiveStatus();
    if (rows.length === 0) {
      // `seedCwd` (passed explicitly by createBoard, see below) wins over
      // a `boards` lookup — createBoard's own setBoards() call hasn't
      // landed in this hook's `boards` state yet when it awaits
      // switchBoard right after (same-render closure, async setState), so
      // looking it up here for a brand-new board would silently find
      // nothing and fall through to `defaultCwd` every time.
      const cwd = seedCwd ?? (boards.find((b) => b.id === boardId)?.cwd || defaultCwd);
      const seeded = seedCards(cwd, nextId, template);
      setCards(seeded);
      setOrder(seeded.map((c) => c.id));
      for (const card of seeded) void window.store.upsert(toRow(card, boardId));
    } else {
      const restored = rows.map(fromRow);
      setCards(restored);
      setOrder(restored.map((c) => c.id));
    }
    refreshBoardCounts();

    // DESIGN-BACKLOG.md item 14 — Home's "último acesso": every real open
    // (not `createBoard`'s own internal switch — harmless if it double-
    // touches, same timestamp either way) bumps this, separately from
    // `updated_at` (metadata edits only, see `updateBoard`'s comment).
    const accessedAt = Date.now();
    void window.store.boards.touch(boardId, accessedAt);
    setBoards((prev) => prev.map((b) => (b.id === boardId ? { ...b, last_accessed_at: accessedAt } : b)));
  }

  // DESIGN-BACKLOG.md item 8 — boots to the home screen, always (decided
  // by the user, not "only when there's no saved session"). No board gets
  // loaded here — `activeBoardId` stays null until the user actually picks
  // one from Home, so no PTY spawns before that either. `ACTIVE_BOARD_KEY`
  // is still written on every switch (below) — kept as a convenience for
  // a future "continue last session" affordance, just never read to
  // auto-load on boot anymore.
  useEffect(() => {
    (async () => {
      const [fetchedBoards, seed] = await Promise.all([window.store.boards.list(), window.store.nextIdSeed()]);
      nextId.current = seed + 1;
      setBoards(fetchedBoards);
      setLoaded(true);
      refreshBoardCounts();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchBoard(id: string, template: SessionTemplate = "empty", seedCwd?: string) {
    if (id === activeBoardIdRef.current) return;
    setActiveBoardId(id);
    localStorage.setItem(ACTIVE_BOARD_KEY, id);
    await loadBoard(id, template, seedCwd);
  }

  /** Topbar's home button — leaves the current board back to the home
   * screen. Same cleanup `loadBoard` already does when swapping BETWEEN
   * boards (cards/connectors/live-status cleared, which is what actually
   * stops the departing board's terminal PTYs — see loadBoard's own doc
   * comment), just landing on "no board" instead of a different one. */
  function goHome() {
    setActiveBoardId(null);
    setCards([]);
    setOrder([]);
    setConnectors([]);
    resetLiveStatus();
  }

  async function createBoard(name: string, cwd: string, template: SessionTemplate = "empty") {
    const id = String(nextId.current++);
    const now = Date.now();
    // `project` is purely a derived display/grouping label now (item 1
    // revisited — "não persiste o caminho correto"): the picker returns a
    // real absolute path, and the label shown in Home/Topbar's grouping is
    // just that path's last segment, never independently typed.
    const project = basename(cwd);
    // DESIGN-BACKLOG.md item 59 — always false at creation, never
    // inherited from anywhere (there's nowhere to inherit it from here —
    // a brand-new board has no prior row). Duplicating a board isn't a
    // feature this app has, so that inheritance path doesn't exist either.
    const board: BoardRow = { id, name, project, cwd, created_at: now, updated_at: now, last_accessed_at: now, autonomous: false };
    setBoards((prev) => [...prev, board]);
    void window.store.boards.upsert(board);
    // `cwd` passed explicitly — see loadBoard's comment on why a `boards`
    // state lookup can't be trusted for a board this fresh.
    await switchBoard(id, template, cwd);
    toast(`sessão "${name}" criada`);
  }

  /** Session name + path, saved together — SessionModal's edit form
   * (DESIGN-BACKLOG.md item 11) always submits both fields at once, and an
   * earlier two-call version (separate renameBoard/changeBoardProject)
   * had a real bug: each read `boards` from its own render's closure, so
   * the second call's DB upsert found the board still carrying the FIRST
   * call's pre-update value — the in-memory state was fine (via `prev`),
   * but the persisted row silently reverted whichever field changed
   * first. One combined update avoids that instead of ordering around it. */
  function updateBoard(id: string, name: string, cwd: string) {
    const now = Date.now();
    const project = basename(cwd);
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, name, project, cwd, updated_at: now } : b)));
    const board = boards.find((b) => b.id === id);
    if (board) void window.store.boards.upsert({ ...board, name, project, cwd, updated_at: now });
  }

  /** DESIGN-BACKLOG.md item 59 — the ONE place this app flips
   * `autonomous`, called only from SessionModal's toggle (via
   * Topbar.tsx/Home.tsx). Deliberately its own function, not folded into
   * `updateBoard`: a safety-relevant setting should apply the instant a
   * human clicks it, not wait behind "Salvar". Uses the dedicated
   * `setAutonomous` IPC (not the general `upsert`) for the same reason
   * message-bus.ts never touches this column — one narrow write path,
   * not the general board-edit one. */
  function setBoardAutonomous(id: string, autonomous: boolean) {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, autonomous } : b)));
    void window.store.boards.setAutonomous(id, autonomous);
    toast(autonomous ? "modo autônomo ativado" : "modo autônomo desativado");
  }

  async function deleteBoard(id: string) {
    if (boards.length <= 1) return;
    const remaining = boards.filter((b) => b.id !== id);
    setBoards(remaining);
    void window.store.boards.delete(id);
    refreshBoardCounts();
    if (id === activeBoardIdRef.current) {
      const next = remaining[0].id;
      setActiveBoardId(next);
      localStorage.setItem(ACTIVE_BOARD_KEY, next);
      await loadBoard(next);
    }
    toast("sessão excluída");
  }

  return {
    loaded,
    boards,
    activeBoardId,
    activeBoardIdRef,
    boardCounts,
    refreshBoardCounts,
    loadBoard,
    switchBoard,
    goHome,
    createBoard,
    updateBoard,
    deleteBoard,
    setBoardAutonomous,
  };
}
