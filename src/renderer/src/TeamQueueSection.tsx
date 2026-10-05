import { useCallback, useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import type { TeamQueueEntryInfo } from "../../preload/index";
import { queueEntriesForBoard } from "./team-board-decisions";
import styles from "./TeamQueueSection.module.css";

/**
 * Tela 13 — the Fila card's "Do time" section: team tasks accepted on this
 * machine, in the local board they were bridged into. Shows the state the app
 * reported back (never the code). "Ver contrato" reveals the local briefing;
 * "Despachar para um agente" opens the SAME local-task detail/spawn flow the
 * Fila already has. The state bridge runs on a light poll here.
 */
export function TeamQueueSection({ boardId, onOpenTask }: { boardId: string | null; onOpenTask?: (localTaskId: string) => void }) {
  const [entries, setEntries] = useState<TeamQueueEntryInfo[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [contract, setContract] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const sync = useCallback(
    async (silent: boolean) => {
      try {
        const res = await window.team.queueSync();
        if (res.ok) {
          setEntries(res.entries);
          if (!silent) {
            const reported = res.reports.filter((r) => r.reported).length;
            setNote(t("teamTask.queue.synced", { n: String(reported) }));
          }
        } else if (!silent) {
          const q = await window.team.queue();
          if (q.ok) setEntries(q.entries);
        }
      } catch {
        /* offline: keep what we have */
      }
    },
    [],
  );

  useEffect(() => {
    void sync(true);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void sync(true);
    }, 15000);
    return () => window.clearInterval(id);
  }, [sync]);

  const mine = queueEntriesForBoard(entries, boardId);

  async function toggleContract(localTaskId: string) {
    if (open[localTaskId]) {
      setOpen((prev) => ({ ...prev, [localTaskId]: false }));
      return;
    }
    if (!contract[localTaskId] && boardId) {
      try {
        const tasks = await window.tasks.listByBoard(boardId);
        const local = tasks.find((task) => task.id === localTaskId);
        if (local) setContract((prev) => ({ ...prev, [localTaskId]: local.prompt ?? "" }));
      } catch {
        /* no briefing available */
      }
    }
    setOpen((prev) => ({ ...prev, [localTaskId]: true }));
  }

  if (mine.length === 0) return null;

  return (
    <section className={styles.section} data-part="team-queue" aria-label={t("teamTask.queue.title")}>
      <div className={styles.head}>
        <span className={styles.tag}>{t("teamTask.queue.city")}</span>
        <span className={styles.headTitle}>{t("teamTask.queue.title")}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className={styles.sync} data-no-drag onClick={() => void sync(false)}>
          {t("teamTask.queue.sync")}
        </button>
      </div>
      {mine.map((entry) => {
        const chip = entry.reportDelivered ? t("teamTask.queue.review") : entry.localStatus === "done" ? t("teamTask.queue.done") : t("teamTask.queue.ready");
        const chipClass = entry.reportDelivered ? styles.chipReview : entry.localStatus === "done" ? styles.chipReview : styles.chipReady;
        return (
          <div key={entry.localTaskId} className={styles.card}>
            <div className={styles.row}>
              <span className={`${styles.chip} ${chipClass}`}>{chip}</span>
              <span className={styles.meta}>{entry.ref}</span>
            </div>
            <span className={styles.title}>{entry.title}</span>
            <span className={styles.meta}>{t("teamTask.queue.bridge")}</span>
            <div className={styles.actions}>
              <button type="button" className={styles.action} data-no-drag onClick={() => void toggleContract(entry.localTaskId)}>
                {t("teamTask.queue.seeContract")}
              </button>
              <button
                type="button"
                className={styles.actionPrimary}
                data-no-drag
                disabled={!onOpenTask}
                onClick={() => onOpenTask?.(entry.localTaskId)}
              >
                {t("teamTask.queue.dispatch")}
              </button>
            </div>
            {open[entry.localTaskId] ? <pre className={styles.contract}>{contract[entry.localTaskId] ?? ""}</pre> : null}
          </div>
        );
      })}
      {note ? <div className={styles.note}>{note}</div> : null}
    </section>
  );
}
