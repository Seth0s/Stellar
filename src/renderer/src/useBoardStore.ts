import { useEffect, useRef, useState } from "react";
import { cascadeSlot, type WorldTransform } from "./board-model";
import type { Card, Connector } from "./card-types";
import { toast } from "./useToast";
import type { BoardCounts, BoardRow, CardRow } from "../../preload/index";
import {
  boardTaskDefaultsToSql,
  diffPreset,
  presetSettingsFromBoard,
  type BoardPreset,
} from "../../main/board-preset-decision";
// O default de concorrência do APP (o mesmo número que a Fila usa para o badge
// de WIP, em `task-board-model.ts`): um cap `null` no board significa "usa este
// número", então sem ele a UI diria "custom" num board que nunca foi mexido.
import { DEFAULT_CONCURRENCY_CAP } from "./task-board-model";
import { t } from "../../shared/i18n";

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
    effort: null,
    systemPrompt: null,
    initialInput: null,
    brief: null,
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
  /** Achado (review adversarial RODADA 4, 2026-09-09) — App.tsx owns the
   * connector-label auto-refresh throttle (`connectorLabelThrottleRef`),
   * this hook doesn't and shouldn't know it exists in general (same
   * boundary as every other setter above: this hook mutates App.tsx's
   * state via callbacks, never reaches into its internals directly).
   * `deleteBoard` below is the one exception that needs a callback of its
   * own rather than reusing `setConnectors`/`resetLiveStatus`: those clear
   * RENDER state (irrelevant once the board's gone either way), but a
   * pending throttled label write for THIS board must be discarded, not
   * flushed, before `activeBoardId` changes — see App.tsx's own doc
   * comment on its board-switch flush `useEffect` for why flushing would
   * be wrong here specifically (the target board no longer exists to
   * write into). */
  discardPendingConnectorLabelsForBoard: (boardId: string) => void,
) {
  const [loaded, setLoaded] = useState(false);
  const [boards, setBoards] = useState<BoardRow[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [boardCounts, setBoardCounts] = useState<Record<string, BoardCounts>>({});
  const activeBoardIdRef = useRef<string | null>(null);
  activeBoardIdRef.current = activeBoardId;
  /** Achado (review adversarial RODADA 5, 2026-09-09) — the signal the
   * reviewer asked to look for before inventing a new one: this hook had
   * NONE tracking "a board switch is between `setActiveBoardId` and the
   * end of `loadBoard`" (`loaded` above is a one-time boot flag, unrelated
   * — checked before adding this). `true` for exactly that window, in
   * both places it exists today (`switchBoard`, and `deleteBoard`'s own
   * `loadBoard` call for whatever board comes next) — a `finally` in both
   * so a rejected/thrown load still clears it. Read by App.tsx's
   * `scheduleConnectorLabelUpdate` (via `decideConnectorLabelSchedule`)
   * to refuse to schedule anything while it's true: `activeBoardIdRef`
   * flips to the incoming board as soon as `setActiveBoardId` is called,
   * but `connectorsRef` (App.tsx) still holds the OUTGOING board's
   * connectors until `loadBoard`'s `setConnectors` call lands after its
   * own `await` — a stale IPC event landing in that gap used to get a
   * throttle snapshot stamped with the WRONG (new) board id. A plain
   * `useRef<boolean>`, not `useState`: nothing should ever re-render off
   * this, it's read synchronously from an event-handling code path, the
   * same shape as `activeBoardIdRef` right above it. */
  const boardTransitionRef = useRef(false);

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
    setConnectors(
      connectorRows.map((r) => ({ id: r.id, fromCardId: r.from_card_id, toCardId: r.to_card_id, kind: r.kind })),
    );
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
    // Achado ao vivo (2026-09-01) — o bus escopa `list_cards` por isto.
    // Antes do `await loadBoard` abaixo de propósito: durante a troca, a
    // resposta certa pra um agente é a sessão de destino, nunca a que
    // está sendo desmontada.
    window.store.boards.setActive(id);
    localStorage.setItem(ACTIVE_BOARD_KEY, id);
    // Achado (review adversarial RODADA 5, 2026-09-09) — flips true right
    // alongside `setActiveBoardId` above (no gap before the `await`), false
    // again once `loadBoard` settles either way (`finally`, not a plain
    // statement after `await` — a thrown/rejected load must not leave this
    // stuck true forever).
    boardTransitionRef.current = true;
    try {
      await loadBoard(id, template, seedCwd);
    } finally {
      boardTransitionRef.current = false;
    }
  }

  /** Topbar's home button — leaves the current board back to the home
   * screen. Same cleanup `loadBoard` already does when swapping BETWEEN
   * boards (cards/connectors/live-status cleared, which is what actually
   * stops the departing board's terminal PTYs — see loadBoard's own doc
   * comment), just landing on "no board" instead of a different one. */
  function goHome() {
    setActiveBoardId(null);
    window.store.boards.setActive(null);
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
    const board: BoardRow = {
      id,
      name,
      project,
      cwd,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      autonomous: false,
      concurrency_cap: null,
      orchestrator_card_id: null,
    };
    setBoards((prev) => [...prev, board]);
    void window.store.boards.upsert(board);
    // `cwd` passed explicitly — see loadBoard's comment on why a `boards`
    // state lookup can't be trusted for a board this fresh.
    await switchBoard(id, template, cwd);
    toast(t("toast.sessionCreated", { name }));
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
    toast(autonomous ? t("toast.autonomousOn") : t("toast.autonomousOff"));
  }

  /** DESIGN-BACKLOG.md item 60, peça 2 — same immediate-fire pattern as
   * setBoardAutonomous, own dedicated IPC. `cap: null` resets to the
   * app-wide default. */
  function setBoardConcurrencyCap(id: string, cap: number | null) {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, concurrency_cap: cap } : b)));
    void window.store.boards.setConcurrencyCap(id, cap);
    toast(cap === null ? t("toast.concurrencyDefault") : t("toast.concurrencyCap", { cap }));
  }

  /**
   * BOARD PRESETS, FASE 2 (task 83f4cfa3) — aplicar um preset no board.
   *
   * As três regras do enunciado, encarnadas aqui:
   *   1. escreve EXATAMENTE o que a UI mostrou: a lista de mudanças vem da
   *      MESMA `diffPreset` que desenhou o "isto vai mudar", e cada ajuste
   *      entra pelo IPC que um clique à mão usa — nada escondido, e nada
   *      escrito quando não há o que mudar (preset já aplicado = zero IPC);
   *   2. não toca card em execução nem task existente: este hook nem alcança
   *      esses estados — o efeito é só sobre defaults do que vem a seguir, e
   *      os callbacks de card/task não são chamados daqui;
   *   3. UM toast para a ação inteira. As funções acima avisam uma a uma porque
   *      cada clique é uma decisão; aplicar um preset é UMA decisão com N
   *      efeitos, e quatro toasts fariam o humano perder o que mudou.
   *
   * O encoding das colunas (`JSON` / `0-1`) vem do módulo puro, o mesmo que o
   * main usa na escrita: o estado local não pode ter um dialeto próprio, senão
   * o badge do preset passa a discordar do banco.
   */
  function applyBoardPreset(id: string, preset: BoardPreset) {
    const board = boards.find((b) => b.id === id);
    if (!board) return;
    const changes = diffPreset(presetSettingsFromBoard(board, DEFAULT_CONCURRENCY_CAP), preset.settings);
    if (changes.length === 0) {
      // Já está assim: aplicar não escreve nada (e não diz que mexeu).
      toast(t("toast.presetAlready", { preset: preset.label }));
      return;
    }
    const changed = new Set(changes.map((c) => c.setting));

    if (changed.has("autonomous")) {
      setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, autonomous: preset.settings.autonomous } : b)));
      void window.store.boards.setAutonomous(id, preset.settings.autonomous);
    }
    if (changed.has("concurrencyCap")) {
      setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, concurrency_cap: preset.settings.concurrencyCap } : b)));
      void window.store.boards.setConcurrencyCap(id, preset.settings.concurrencyCap);
    }
    const defaultsWrite = {
      review: preset.settings.defaultReview,
      reportSchema: preset.settings.defaultReportSchema,
      allowCommit: preset.settings.defaultAllowCommit,
    };
    if (changed.has("defaultReview") || changed.has("defaultReportSchema") || changed.has("defaultAllowCommit")) {
      setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, ...boardTaskDefaultsToSql(defaultsWrite) } : b)));
      void window.store.boards.setDefaults(id, defaultsWrite).then((res) => {
        if (!res.ok) {
          // Recusa (forma inválida ou board sumiu entre o clique e a escrita):
          // a UI volta a ler o banco em vez de manter o otimismo — "aplicado"
          // nunca pode ser dito sobre uma escrita que não aconteceu.
          void window.store.boards.list().then(setBoards);
          return;
        }
      });
    }
    toast(t("toast.presetApplied", { preset: preset.label, count: changes.length }));
  }

  /** Board orchestrator mark — UI-only, same immediate-fire pattern as
   * setBoardAutonomous. `cardId: null` clears. Replacing is intentional
   * (one card per board). */
  function setBoardOrchestratorCard(boardId: string, cardId: string | null) {
    setBoards((prev) => prev.map((b) => (b.id === boardId ? { ...b, orchestrator_card_id: cardId } : b)));
    void window.store.boards.setOrchestratorCard(boardId, cardId).then((ok) => {
      if (!ok) {
        // Revert optimistic update if the store refused (wrong board/kind).
        void window.store.boards.list().then(setBoards);
        return;
      }
      toast(cardId ? t("toast.orchestratorOn") : t("toast.orchestratorOff"));
    });
  }

  /** Keep renderer board state in sync when a card is deleted — the
   * store already cleared `orchestrator_card_id` inside `deleteCard`. */
  function clearOrchestratorMarkIfCard(cardId: string) {
    setBoards((prev) =>
      prev.map((b) => (b.orchestrator_card_id === cardId ? { ...b, orchestrator_card_id: null } : b)),
    );
  }

  async function deleteBoard(id: string) {
    if (boards.length <= 1) return;
    // Achado (review adversarial RODADA 4, 2026-09-09) — BEFORE anything
    // else, and unconditionally (pending entries only ever exist for
    // whatever board is currently loaded, so this is a no-op for a board
    // that isn't `id === activeBoardIdRef.current`, but checking that here
    // would just be one more place to get the condition wrong). Must run
    // before `setActiveBoardId` below: that's what fires App.tsx's board-
    // switch flush effect, and this board's rows are being deleted right
    // here — nothing pending for it should survive to be flushed into a
    // `board_id` that's about to stop existing.
    discardPendingConnectorLabelsForBoard(id);
    const remaining = boards.filter((b) => b.id !== id);
    setBoards(remaining);
    void window.store.boards.delete(id);
    refreshBoardCounts();
    if (id === activeBoardIdRef.current) {
      const next = remaining[0].id;
      setActiveBoardId(next);
      localStorage.setItem(ACTIVE_BOARD_KEY, next);
      // Achado (review adversarial RODADA 5, 2026-09-09) — same guard as
      // `switchBoard`'s own `boardTransitionRef` bracket; see its comment
      // there for why. This is the OTHER of the two places `loadBoard` is
      // awaited after `activeBoardId` already changed.
      boardTransitionRef.current = true;
      try {
        await loadBoard(next);
      } finally {
        boardTransitionRef.current = false;
      }
    }
    toast(t("toast.sessionDeleted"));
  }

  return {
    loaded,
    boards,
    activeBoardId,
    activeBoardIdRef,
    // Achado (review adversarial RODADA 5, 2026-09-09) — App.tsx's
    // `scheduleConnectorLabelUpdate` needs to read this synchronously;
    // see its own doc comment above for what it means.
    boardTransitionRef,
    boardCounts,
    refreshBoardCounts,
    loadBoard,
    switchBoard,
    goHome,
    createBoard,
    updateBoard,
    deleteBoard,
    setBoardAutonomous,
    setBoardConcurrencyCap,
    applyBoardPreset,
    setBoardOrchestratorCard,
    clearOrchestratorMarkIfCard,
  };
}
