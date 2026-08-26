import { useEffect, useRef, useState } from "react";
import { cascadeSlot, type WorldTransform } from "./board-model";
import type { Card, Connector } from "./card-types";
import { toast } from "./useToast";
import type { BoardCounts, BoardRow, CardRow } from "../../preload/index";

const ACTIVE_BOARD_KEY = "ac.activeBoardId";

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
  async function loadBoard(boardId: string) {
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
      const id = String(nextId.current++);
      const card: Card = {
        id,
        kind: "terminal",
        provider: "bash",
        cwd: defaultCwd,
        resumeId: null,
        continueLast: false,
        model: null,
        systemPrompt: null,
        rect: cascadeSlot(0),
        groupId: null,
        label: null,
      };
      setCards([card]);
      setOrder([id]);
      void window.store.upsert(toRow(card, boardId));
    } else {
      const restored = rows.map(fromRow);
      setCards(restored);
      setOrder(restored.map((c) => c.id));
    }
    refreshBoardCounts();
  }

  useEffect(() => {
    (async () => {
      const [fetchedBoards, seed] = await Promise.all([window.store.boards.list(), window.store.nextIdSeed()]);
      nextId.current = seed + 1;
      setBoards(fetchedBoards);
      const stored = localStorage.getItem(ACTIVE_BOARD_KEY);
      const initial = fetchedBoards.find((b) => b.id === stored)?.id ?? fetchedBoards[0]?.id ?? "default";
      setActiveBoardId(initial);
      await loadBoard(initial);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchBoard(id: string) {
    if (id === activeBoardIdRef.current) return;
    setActiveBoardId(id);
    localStorage.setItem(ACTIVE_BOARD_KEY, id);
    await loadBoard(id);
  }

  async function createBoard(name: string, project: string) {
    const id = String(nextId.current++);
    const now = Date.now();
    const board: BoardRow = { id, name, project, created_at: now, updated_at: now };
    setBoards((prev) => [...prev, board]);
    void window.store.boards.upsert(board);
    await switchBoard(id);
    toast(`sessão "${name}" criada`);
  }

  function renameBoard(id: string, name: string) {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, name, updated_at: Date.now() } : b)));
    const board = boards.find((b) => b.id === id);
    if (board) void window.store.boards.upsert({ ...board, name, updated_at: Date.now() });
  }

  function changeBoardProject(id: string, project: string) {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, project, updated_at: Date.now() } : b)));
    const board = boards.find((b) => b.id === id);
    if (board) void window.store.boards.upsert({ ...board, project, updated_at: Date.now() });
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
    createBoard,
    renameBoard,
    changeBoardProject,
    deleteBoard,
  };
}
