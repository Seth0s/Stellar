import { RailGlyphCheck, RailGlyphPen } from "./RailGlyphs";
import { groupByProject, type Board, type BoardCounts } from "./sessions";
import { t } from "../../shared/i18n";
import styles from "./RailSessionsPanel.module.css";

function agentsLabel(count: number | undefined): string {
  if (!count) return t("rail.v3.sessions.agentsNone");
  return count === 1 ? t("rail.v3.sessions.agentsOne") : t("rail.v3.sessions.agentsMany", { count: String(count) });
}

/**
 * The session list the Board panel's "Trocar de sessão…" leads to: sessions of
 * the current scope grouped by project, the active one marked, a pencil to edit
 * and the two actions below. Creating / editing keep their modals (Topbar).
 */
export function RailSessionsPanel({
  boards,
  boardCounts,
  activeBoardId,
  onBack,
  onSwitch,
  onEdit,
  onNew,
  onArchived,
}: {
  boards: Board[];
  boardCounts: Record<string, BoardCounts>;
  activeBoardId: string | null;
  onBack: () => void;
  onSwitch: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
  onArchived: () => void;
}) {
  return (
    <div className={styles.panel} data-role="rail-sessions">
      <button type="button" className={styles.back} data-role="rail-sessions-back" onClick={onBack}>
        ‹ {t("rail.v3.title.board")}
      </button>
      <div className={styles.groups}>
        {groupByProject(boards).map(([project, group]) => (
          <div key={project} className={styles.group}>
            <span className={styles.groupHead}>{project}</span>
            {group.map((b) => {
              const active = b.id === activeBoardId;
              return (
                <div
                  key={b.id}
                  className={`${styles.row}${active ? ` ${styles.rowOn}` : ""}`}
                  data-role="session-row"
                  data-active={active ? "true" : undefined}
                  data-board-id={b.id}
                >
                  <button type="button" className={styles.pick} title={b.cwd || undefined} onClick={() => onSwitch(b.id)}>
                    <span className={styles.stack}>
                      <span className={styles.name}>
                        {b.name}
                        {active && (
                          <span className={styles.check}>
                            <RailGlyphCheck size={13} />
                          </span>
                        )}
                      </span>
                      <span className={styles.sub}>{agentsLabel(boardCounts[b.id]?.agents)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.edit}
                    data-role="edit-session"
                    aria-label={t("topbar.editSession")}
                    title={t("topbar.editSession")}
                    onClick={() => onEdit(b.id)}
                  >
                    <RailGlyphPen size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={styles.actions}>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} data-role="session-new" onClick={onNew}>
          {t("rail.v3.sessions.new")}
        </button>
        <button type="button" className={styles.btn} data-role="open-archived" onClick={onArchived}>
          {t("archived.title")}
        </button>
      </div>
    </div>
  );
}
