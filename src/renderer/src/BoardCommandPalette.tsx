/**
 * Board Ctrl+K palette — task commands from BoardQuickTask.dc.html.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../shared/i18n";
import { visibleBoardCommands, type BoardCmdId } from "./board-quick-task-decisions";
import styles from "./BoardCommandPalette.module.css";

export type BoardCommandPaletteProps = {
  selectionCount: number;
  /** null = no team connected → Distribuir row hidden. */
  unassignedCount: number | null;
  onClose: () => void;
  onCommand: (id: BoardCmdId, query: string) => void;
};

const SHORTCUT: Partial<Record<BoardCmdId, string>> = {
  "new-board": "N",
  "new-team": "Shift N",
};

function CmdIcon({ id }: { id: BoardCmdId }): ReactNode {
  const stroke = "currentColor";
  if (id === "new-board") {
    return (
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke={stroke} strokeWidth="1.6" aria-hidden="true">
        <path d="M7 2.5v9M2.5 7h9" />
      </svg>
    );
  }
  if (id === "new-team") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <circle cx="5.8" cy="5.6" r="2.3" />
        <circle cx="11" cy="6.3" r="1.8" />
        <path d="M1.8 13c.4-2.3 2-3.6 4-3.6s3.6 1.3 4 3.6" />
      </svg>
    );
  }
  if (id === "distribute") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
      </svg>
    );
  }
  if (id === "import") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" />
      </svg>
    );
  }
  if (id === "selection-to-task") {
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <path d="M5 7h6M5 10h4" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
    </svg>
  );
}

function labelFor(id: BoardCmdId, unassignedCount: number | null): string {
  if (id === "new-board") return t("boardCmd.newBoard");
  if (id === "new-team") return t("boardCmd.newTeam");
  if (id === "distribute") return t("boardCmd.distribute", { n: String(unassignedCount ?? 0) });
  if (id === "import") return t("boardCmd.import");
  if (id === "selection-to-task") return t("boardCmd.selection");
  return t("boardCmd.openById");
}

export function BoardCommandPalette({ selectionCount, unassignedCount, onClose, onCommand }: BoardCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const teamConnected = unassignedCount !== null;
  const cmds = useMemo(() => visibleBoardCommands(query, { teamConnected }), [query, teamConnected]);

  useEffect(() => {
    setActive(0);
  }, [query, teamConnected]);

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

  function run(id: BoardCmdId) {
    onCommand(id, query);
  }

  return createPortal(
    <div className={styles.overlay} role="presentation" data-part="board-cmd-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-label={t("boardCmd.aria")}
        data-part="board-cmd-palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.head}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#8d94a6" strokeWidth="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <label htmlFor="board-cmd-input" className={styles.srOnly}>
            {t("boardCmd.input")}
          </label>
          <input
            id="board-cmd-input"
            className={styles.input}
            data-part="board-cmd-input"
            value={query}
            autoFocus
            placeholder={t("boardCmd.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, Math.max(0, cmds.length - 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const cmd = cmds[active];
                if (cmd) run(cmd.id);
              }
            }}
          />
          <span className={styles.k} data-part="board-cmd-kbd">
            Ctrl K
          </span>
        </div>
        <div className={styles.list}>
          <div className={styles.section}>TASKS</div>
          {cmds.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              className={`${styles.cmd}${i === active ? ` ${styles.cmdActive}` : ""}`}
              data-part={`board-cmd-${cmd.id}`}
              data-active={i === active ? "true" : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(cmd.id)}
            >
              <span className={styles.cmdIcon} aria-hidden="true">
                <CmdIcon id={cmd.id} />
              </span>
              <span className={styles.cmdLabel}>{labelFor(cmd.id, unassignedCount)}</span>
              {cmd.id === "selection-to-task" ? (
                <span className={styles.cmdMeta}>{t("boardCmd.selectionMeta", { n: String(selectionCount) })}</span>
              ) : SHORTCUT[cmd.id] ? (
                <span className={styles.k}>{SHORTCUT[cmd.id]}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
