/**
 * Screen 15 — quick task create on the board (BoardQuickTask.dc.html).
 * Local "mais opções" / detail opens CreateTask (app-v3); team keeps TeamTaskForm.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../shared/i18n";
import {
  QUICK_KINDS,
  canSubmitQuick,
  emptyQuickTask,
  type QuickTaskKind,
  type QuickTaskState,
} from "./board-quick-task-decisions";
import { CreateTaskModal } from "./CreateTaskModal";
import {
  seedFromQuick,
  type ActiveTerritoryTask,
} from "./create-task-form-decisions";
import type { TaskDestination } from "./team-task-form-decisions";
import styles from "./BoardQuickTask.module.css";

const KIND_LABEL: Record<QuickTaskKind, string> = {
  investigar: "Investigar",
  implementar: "Implementar",
  corrigir: "Corrigir",
  medir: "Medir",
};

export type BoardQuickTaskProps = {
  boardId?: string;
  boardName: string;
  teamName: string | null;
  teamAvailable: boolean;
  initial: Partial<QuickTaskState>;
  busy?: boolean;
  error?: string | null;
  activeTasks?: readonly ActiveTerritoryTask[];
  onClose: () => void;
  onCreate: (state: QuickTaskState) => void;
  /** Team destination (or when boardId is absent) — opens TeamTaskForm. */
  onDetail: (state: QuickTaskState) => void;
  onLocalCreated?: (taskId: string) => void;
};

export function BoardQuickTask({
  boardId,
  boardName,
  teamName,
  teamAvailable,
  initial,
  busy = false,
  error = null,
  activeTasks = [],
  onClose,
  onCreate,
  onDetail,
  onLocalCreated,
}: BoardQuickTaskProps) {
  const [state, setState] = useState<QuickTaskState>(() => ({
    ...emptyQuickTask(initial.destination ?? "board"),
    ...initial,
  }));
  const [localCreateOpen, setLocalCreateOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set<K extends keyof QuickTaskState>(key: K, value: QuickTaskState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  function submit() {
    if (!canSubmitQuick(state) || busy) return;
    onCreate(state);
  }

  function openDetail() {
    if (state.destination === "board" && boardId) {
      setLocalCreateOpen(true);
      return;
    }
    onDetail(state);
  }

  if (localCreateOpen && boardId) {
    return (
      <CreateTaskModal
        open
        boardId={boardId}
        boardName={boardName}
        seed={seedFromQuick({
          title: state.title,
          kind: state.kind,
          contract: state.contract,
          territory: state.territory,
        })}
        activeTasks={activeTasks}
        onClose={() => {
          setLocalCreateOpen(false);
          onClose();
        }}
        onCreated={(taskId) => {
          onLocalCreated?.(taskId);
          setLocalCreateOpen(false);
          onClose();
        }}
      />
    );
  }

  return createPortal(
    <div className={styles.overlay} role="presentation" data-part="board-quick-task-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-label={t("boardQuick.aria")}
        data-part="board-quick-task"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <label htmlFor="board-quick-title" className={styles.srOnly}>
          {t("boardQuick.titleLabel")}
        </label>
        <input
          id="board-quick-title"
          className={styles.titleInput}
          data-part="board-quick-title"
          value={state.title}
          autoFocus
          disabled={busy}
          onChange={(e) => set("title", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className={styles.pills} role="radiogroup" aria-label={t("boardQuick.kind")}>
          {QUICK_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={state.kind === kind}
              className={`${styles.pill}${state.kind === kind ? ` ${styles.pillOn}` : ""}`}
              data-part={`board-quick-kind-${kind}`}
              disabled={busy}
              onClick={() => set("kind", kind)}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className={styles.destLabel}>{t("boardQuick.for")}</span>
          <div className={styles.destGrid}>
            <button
              type="button"
              className={`${styles.destBtn}${state.destination === "board" ? ` ${styles.destBtnOn}` : ""}`}
              aria-pressed={state.destination === "board"}
              data-part="board-quick-dest-board"
              disabled={busy}
              onClick={() => set("destination", "board" as TaskDestination)}
            >
              <span className={styles.destTitle}>{t("boardQuick.dest.board")}</span>
              <span className={styles.destHint} data-board-name={boardName}>
                {t("boardQuick.dest.boardHint")}
              </span>
            </button>
            <button
              type="button"
              className={`${styles.destBtn}${state.destination === "team" ? ` ${styles.destBtnOn}` : ""}`}
              aria-pressed={state.destination === "team"}
              data-part="board-quick-dest-team"
              disabled={busy || !teamAvailable}
              onClick={() => teamAvailable && set("destination", "team" as TaskDestination)}
            >
              <span className={styles.destTitle}>
                {t("boardQuick.dest.team", { team: teamName ?? "—" })}
              </span>
              <span className={styles.destHint}>{t("boardQuick.dest.teamHint")}</span>
            </button>
          </div>
        </div>
        {state.territory[0] ? (
          <div className={styles.territory} data-part="board-quick-territory">
            {t("boardQuick.territory")}{" "}
            <span className={styles.territoryPath}>{state.territory[0]}</span>
            {t("boardQuick.territoryHint")}
          </div>
        ) : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        <div className={styles.actions}>
          <button type="button" className={styles.detailLink} data-part="board-quick-detail" disabled={busy} onClick={openDetail}>
            {t("boardQuick.moreOptions")}
          </button>
          <button type="button" className={styles.ghost} data-part="board-quick-cancel" disabled={busy} onClick={onClose}>
            {t("boardQuick.cancel")}
          </button>
          <button
            type="button"
            className={styles.primary}
            data-part="board-quick-create"
            disabled={busy || !canSubmitQuick(state)}
            onClick={submit}
          >
            {t("boardQuick.create")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
