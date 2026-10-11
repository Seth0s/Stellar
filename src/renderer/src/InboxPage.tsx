import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../shared/i18n";
import type { InboxActionId, InboxItemInfo, InboxSnapshotInfo, InboxTabId } from "../../preload/index";
import styles from "./InboxPage.module.css";

const TABS: InboxTabId[] = ["all", "review", "requests", "assigned", "mentions"];

function tabLabel(tab: InboxTabId): string {
  switch (tab) {
    case "all":
      return t("inbox.tab.all");
    case "review":
      return t("inbox.tab.review");
    case "requests":
      return t("inbox.tab.requests");
    case "assigned":
      return t("inbox.tab.assigned");
    case "mentions":
      return t("inbox.tab.mentions");
  }
}

function actionLabel(action: InboxActionId, item: InboxItemInfo): string {
  switch (action) {
    case "open":
      return t("inbox.action.open");
    case "review_now":
      return t("inbox.action.reviewNow");
    case "assign_to":
      return t("inbox.action.assignTo", { name: item.claimantName || t("inbox.action.person") });
    case "reject":
      return t("inbox.action.reject");
    case "accept":
      return t("inbox.action.accept");
    case "return":
      return t("inbox.action.return");
    case "redistribute":
      return t("inbox.action.redistribute");
    case "gate_output":
      return t("inbox.action.gateOutput");
    case "reply":
      return t("inbox.action.reply");
    case "view":
      return t("inbox.action.view");
  }
}

function avatarClass(tone: InboxItemInfo["avatarTone"]): string {
  if (tone === "warn") return styles.avWarn;
  if (tone === "info") return styles.avInfo;
  if (tone === 1) return styles.av1;
  if (tone === 2) return styles.av2;
  if (tone === 3) return styles.av3;
  if (tone === 4) return styles.av4;
  if (tone === 5) return styles.av5;
  return styles.av0;
}

function kindMatchesTab(kind: string, tab: InboxTabId): boolean {
  if (tab === "all") return true;
  if (tab === "review") return kind === "revisar";
  if (tab === "requests") return kind === "pedido_pegar" || kind === "devolucao";
  if (tab === "assigned") return kind === "atribuicao";
  if (tab === "mentions") return kind === "mencao";
  return false;
}

/**
 * Account inbox page: team items from the cloud inbox API plus local
 * awaiting_review rows, with per-row actions and notification prefs.
 */
export function InboxPage({
  boards,
  onOpenBoard,
  onOpenTeamTask,
}: {
  boards: { id: string; name: string }[];
  onOpenBoard: (boardId: string) => void;
  onOpenTeamTask?: (teamId: string, taskId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<InboxSnapshotInfo | null>(null);
  const [tab, setTab] = useState<InboxTabId>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!window.inbox?.snapshot) return;
    void window.inbox.snapshot().then(setSnapshot).catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    if (!window.inbox?.onSnapshot) return;
    return window.inbox.onSnapshot(setSnapshot);
  }, [reload]);

  const visible = useMemo(() => {
    const items = snapshot?.items ?? [];
    return items.filter((item) => kindMatchesTab(item.kind, tab));
  }, [snapshot, tab]);

  async function runAction(item: InboxItemInfo, action: InboxActionId) {
    setBusyId(item.id);
    try {
      if (action === "open" || action === "review_now" || action === "view" || action === "gate_output" || action === "reply" || action === "redistribute") {
        if (item.source === "local" && item.boardId) {
          onOpenBoard(item.boardId);
        } else if (item.teamId && item.taskId && onOpenTeamTask) {
          onOpenTeamTask(item.teamId, item.taskId);
        } else if (item.boardId) {
          onOpenBoard(item.boardId);
        }
        if (item.source === "team") void window.inbox.markSeen(item.id);
        return;
      }

      if (!item.teamId || !item.taskId) return;

      if (action === "assign_to" && item.claimId) {
        await window.team.decideClaim(item.teamId, item.taskId, item.claimId, true);
      } else if (action === "reject") {
        if (item.claimId) await window.team.decideClaim(item.teamId, item.taskId, item.claimId, false);
      } else if (action === "accept") {
        const boardId = boards[0]?.id;
        if (!boardId) return;
        await window.team.acceptTask(item.teamId, item.taskId, { boardId });
      } else if (action === "return") {
        await window.team.returnTask(item.teamId, item.taskId);
      }
      reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.page} data-page="inbox">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{t("shell.inbox")}</h1>
          <div className={styles.sub}>{t("inbox.subtitle")}</div>
          {snapshot?.offline ? <div className={styles.offline}>{t("inbox.offline")}</div> : null}
        </div>
        <button type="button" className={styles.ghost} data-role="inbox-mark-all" onClick={() => void window.inbox.markAllSeen().then(reload)}>
          {t("inbox.markAllSeen")}
        </button>
      </div>

      <div className={styles.tabs} role="tablist" aria-label={t("inbox.filter")}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-tab={id}
            className={`${styles.tab}${tab === id ? ` ${styles.tabOn}` : ""}`}
            onClick={() => setTab(id)}
          >
            {tabLabel(id)}
            <span className={styles.cnt}>{snapshot?.counts[id] ?? 0}</span>
          </button>
        ))}
      </div>

      <section className={styles.list} aria-label={t("inbox.items")}>
        {visible.length === 0 ? (
          <div className={styles.empty} data-role="inbox-empty">
            {t("shell.inbox.empty")}
          </div>
        ) : (
          visible.map((item) => (
            <div key={item.id} className={styles.item} data-inbox-item={item.id} data-kind={item.kind}>
              <span className={`${styles.av} ${avatarClass(item.avatarTone)}`}>{item.avatarInitials}</span>
              <span className={styles.body}>
                <span className={styles.line}>
                  {item.title ? `${item.title} ` : null}
                  {item.kind === "pedido_pegar" ? (
                    <>
                      <span className={styles.hi}>{item.claimantName || t("inbox.action.person")}</span>
                      {` ${t("inbox.line.askedFor")} `}
                      <span className={styles.hi}>{item.highlight}</span>
                    </>
                  ) : item.kind === "devolucao" ? (
                    <>
                      <span className={styles.hi}>{item.claimantName || t("inbox.action.person")}</span>
                      {` ${t("inbox.line.returned")} `}
                      <span className={styles.hi}>{item.highlight}</span>
                    </>
                  ) : item.kind === "mencao" ? (
                    <>
                      <span className={styles.hi}>{item.claimantName || t("inbox.action.person")}</span>
                      {` ${t("inbox.line.mentioned")} `}
                      <span className={styles.hi}>{item.highlight}</span>
                    </>
                  ) : (
                    <span className={styles.hi}>{item.highlight}</span>
                  )}
                </span>
                <span className={`${styles.meta}${item.kind === "gate_falhou" ? ` ${styles.metaDanger}` : ""}`}>{item.meta}</span>
              </span>
              <span className={styles.actions}>
                {item.actions.map((action) => {
                  const primary = action === item.primaryAction;
                  return (
                    <button
                      key={action}
                      type="button"
                      data-action={action}
                      className={primary ? styles.primary : styles.ghost}
                      disabled={busyId === item.id}
                      onClick={() => void runAction(item, action)}
                    >
                      {actionLabel(action, item)}
                    </button>
                  );
                })}
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
