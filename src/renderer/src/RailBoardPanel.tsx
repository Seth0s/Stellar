import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import type { BoardAgentRoleRow } from "../../preload/index";
import { describeCardRole } from "./TaskCard";
import { shortTaskId } from "./task-board-model";
import type { RailCard } from "./Rail";
import styles from "./RailBoardPanel.module.css";

/** Board / session facts the rail shows now that the top bar is gone. */
export type RailBoardInfo = {
  boardId: string;
  /** Last path segment of the workspace root — first crumb. */
  rootName: string;
  project: string;
  boardName: string;
  autonomous: boolean;
  orchestratorCardId: string | null;
  /** The marked orchestrator still resolves to a card on this board. */
  orchestratorPresent: boolean;
};

function statusDotClass(tone: RailCard["statusTone"]): string {
  if (tone === "live") return styles.dotLive;
  if (tone === "wait") return styles.dotWait;
  return styles.dotIdle;
}

/**
 * The "Board" panel: where the path, the autonomous mode, the orchestrator
 * mark and the open agents live. Roles per task come from the main process on
 * open (never polled) — a card with no open task shows no role, not "idle".
 */
export function RailBoardPanel({
  board,
  cards,
  loadAgentRoles,
  onOpenSessions,
}: {
  board: RailBoardInfo;
  cards: RailCard[];
  /** False for the prototype seed, which supplies its own agents. */
  loadAgentRoles: boolean;
  onOpenSessions: () => void;
}) {
  const [roles, setRoles] = useState<BoardAgentRoleRow[] | null>(null);

  useEffect(() => {
    if (!loadAgentRoles) return;
    let cancelled = false;
    setRoles(null);
    void window.store.boardAgentRoles(board.boardId).then((rows) => {
      if (!cancelled) setRoles(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [board.boardId, loadAgentRoles]);

  const agents = cards.filter((c) => c.isAgent);
  const rolesByCard = new Map((roles ?? []).map((r) => [r.cardId, r.roles]));
  const orchestratorLabel = cards.find((c) => c.id === board.orchestratorCardId)?.label ?? board.orchestratorCardId;

  return (
    <div className={styles.panel} data-role="rail-board-panel">
      <div className={styles.row}>
        <span className={styles.label}>{t("rail.v3.board.path")}</span>
        <span className={styles.path} data-role="rail-board-path">
          {board.rootName} <span className={styles.sep}>›</span> {board.project} <span className={styles.sep}>›</span>{" "}
          <strong className={styles.strong}>{board.boardName}</strong>
        </span>
        <button type="button" className={styles.link} data-role="rail-switch-session" onClick={onOpenSessions}>
          {t("rail.v3.board.switchSession")}
        </button>
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t("rail.v3.board.mode")}</span>
        {board.autonomous ? (
          <span className={styles.modeLine} title={t("topbar.autonomousTitle")} data-role="rail-board-autonomous">
            <span className={styles.chip}>{t("topbar.autonomous")}</span>
            <span className={styles.soft}>{t("rail.v3.board.autonomousNote")}</span>
          </span>
        ) : (
          <span className={styles.value}>{t("rail.v3.board.manual")}</span>
        )}
      </div>

      <div className={styles.row}>
        <span className={styles.label}>{t("rail.v3.board.orchestrator")}</span>
        {board.orchestratorCardId ? (
          <span
            className={`${styles.value}${board.orchestratorPresent ? "" : ` ${styles.warn}`}`}
            data-role="topbar-orchestrator-badge"
            data-missing={board.orchestratorPresent ? undefined : "true"}
            title={
              board.orchestratorPresent
                ? t("topbar.orchestratorTitle", { id: board.orchestratorCardId })
                : t("topbar.orchestratorMissingTitle", { id: board.orchestratorCardId })
            }
          >
            {board.orchestratorPresent ? orchestratorLabel : t("topbar.orchestratorMissing")}
          </span>
        ) : (
          <span className={`${styles.value} ${styles.soft}`} data-role="topbar-orchestrator-empty" title={t("topbar.orchestratorNoneTitle")}>
            {t("rail.v3.board.orchestratorNone")}
          </span>
        )}
      </div>

      <div className={styles.row} data-role="rail-board-agents">
        <span className={styles.label}>{t("rail.v3.board.agents", { count: String(agents.length) })}</span>
        {agents.length === 0 ? (
          <span className={`${styles.value} ${styles.soft}`}>{t("topbar.agentsNone")}</span>
        ) : (
          <div className={styles.agents}>
            {agents.map((a) => {
              const agentRoles = rolesByCard.get(a.id) ?? [];
              return (
                <div key={a.id} className={styles.agent} data-role="topbar-agent-row" data-card-id={a.id}>
                  <span className={`${styles.dot} ${statusDotClass(a.statusTone)}`} />
                  <span className={styles.agentName}>{a.label ?? a.id}</span>
                  <span className={styles.agentStatus}>{a.statusText}</span>
                  {agentRoles.length > 0 && (
                    <span className={styles.agentRoles}>
                      {agentRoles.map((link) => (
                        <span
                          key={link.taskId}
                          data-role="topbar-agent-role"
                          title={t("topbar.agentsRoleTask", { role: describeCardRole(link.role), task: link.taskId })}
                        >
                          {describeCardRole(link.role)} <code>{shortTaskId(link.taskId)}</code>
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
