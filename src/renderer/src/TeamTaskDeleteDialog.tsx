import { useState } from "react";
import { t } from "../../shared/i18n";
import type { TeamTaskDependencyInfo, TeamTaskInfo } from "../../preload/index";
import {
  canConfirmDelete,
  deleteDescriptionKey,
  deleteImpact,
  deleteSubmitKey,
  type DeleteMode,
} from "./team-task-delete-decisions";
import styles from "./TeamTaskDeleteDialog.module.css";

function impactDotClass(key: string): string {
  if (key === "teamTask.delete.impact.agent") return styles.dotAgent;
  if (key === "teamTask.delete.impact.history") return styles.dotHistory;
  return styles.dotDependent;
}

/**
 * Screen 17 — archive (default, restorable) or delete-forever, which requires
 * typing the task's id. Shows what happens first: the running agent, the
 * dependent tasks and where the history goes.
 */
export function TeamTaskDeleteDialog({
  task,
  dependents,
  initialMode = "archive",
  busy,
  onClose,
  onArchive,
  onDelete,
}: {
  task: TeamTaskInfo;
  dependents: readonly TeamTaskDependencyInfo[];
  initialMode?: DeleteMode;
  busy: boolean;
  onClose: () => void;
  onArchive: () => void;
  onDelete: (confirm: string) => void;
}) {
  const [mode, setMode] = useState<DeleteMode>(initialMode);
  const [confirm, setConfirm] = useState("");
  const impacts = deleteImpact(task, dependents);
  const canPurge = canConfirmDelete(confirm, task.ref);

  return (
    <div className={styles.overlay} role="presentation">
      <div
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-label={t("teamTask.delete.title", { title: task.title })}
      >
        <div className={styles.head}>
          <span className={styles.icon} aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
            </svg>
          </span>
          <div className={styles.headText}>
            <h1 className={styles.title}>{t("teamTask.delete.title", { title: task.title })}</h1>
            <p className={styles.desc}>{t(deleteDescriptionKey(task, dependents))}</p>
          </div>
        </div>

        <ul className={styles.impacts}>
          {impacts.map((line) => (
            <li key={line.key} className={styles.impact}>
              <span className={`${styles.dot} ${impactDotClass(line.key)}`} aria-hidden="true" />
              {t(line.key, line.params)}
            </li>
          ))}
        </ul>

        <div className={styles.modes} role="radiogroup" aria-label={t("teamTask.delete.title", { title: task.title })}>
          <label className={`${styles.opt}${mode === "archive" ? ` ${styles.optOn}` : ""}`}>
            <input type="radio" name="delete-mode" checked={mode === "archive"} onChange={() => setMode("archive")} />
            <span className={styles.optText}>
              <span className={styles.optTitle}>
                {t("teamTask.delete.mode.archive")}
                <span className={styles.optTag}>{t("teamTask.delete.mode.archiveTag")}</span>
              </span>
              <span className={styles.optDesc}>{t("teamTask.delete.mode.archiveDesc")}</span>
            </span>
          </label>
          <label className={`${styles.opt}${mode === "purge" ? ` ${styles.optOn}` : ""}`}>
            <input type="radio" name="delete-mode" checked={mode === "purge"} onChange={() => setMode("purge")} />
            <span className={styles.optText}>
              <span className={styles.optTitle}>{t("teamTask.delete.mode.purge")}</span>
              <span className={styles.optDesc}>{t("teamTask.delete.mode.purgeDesc")}</span>
            </span>
          </label>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>{t("teamTask.delete.confirmLabel", { ref: task.ref })}</span>
          <input
            className={styles.confirm}
            disabled={mode !== "purge"}
            value={confirm}
            placeholder={task.ref}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>

        <div className={styles.foot}>
          <button type="button" className={styles.ghost} onClick={onClose}>
            {t("teamTask.form.cancel")}
          </button>
          <button
            type="button"
            className={styles.danger}
            disabled={busy || (mode === "purge" && !canPurge)}
            onClick={() => (mode === "purge" ? onDelete(confirm) : onArchive())}
          >
            {t(deleteSubmitKey(mode))}
          </button>
        </div>
      </div>
    </div>
  );
}
