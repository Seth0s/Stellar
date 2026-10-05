import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { ConfirmModal } from "./ConfirmModal";
import { SessionModal } from "./SessionModal";
import { groupByProject, type Board, type BoardCounts } from "./sessions";
import type { SessionTemplate } from "./useBoardStore";
import type { BoardBackgroundStatus, BoardRow, BoardSummary } from "../../preload/index";
import { useAvailableAgentProviders } from "./useAgentAvailability";
import { abbreviateHome, filterSessions, pickContinueBoard, recentBadgeId, sortGroupsByName } from "./home-decisions";
import { decideStopSessionConfirm } from "../../main/session-background";
import { t, formatRelativeTime, getLocale } from "../../shared/i18n";
import styles from "./Home.module.css";

type ModalState = { mode: "create"; cwd?: string } | { mode: "edit"; board: Board } | null;
type SortMode = "recent" | "name";
type ViewMode = "grid" | "list";

const PROVIDER_COLOR: Record<string, string> = {
  claude: "var(--accent-claude)",
  codex: "var(--accent-codex)",
  cursor: "var(--accent-cursor)",
  antigravity: "var(--accent-antigravity)",
  gemini: "var(--accent-antigravity)",
  commandcode: "var(--accent-commandcode)",
  opencode: "var(--accent-opencode)",
  cline: "var(--accent-cline)",
};

function providerColor(id: string): string {
  return PROVIDER_COLOR[id] ?? "var(--v2-text-6)";
}

function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleDateString(getLocale());
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs >= 30 * 24 * 60 * 60 * 1000) return formatAbsolute(ts);
  return formatRelativeTime(ts, Date.now());
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** The tasks waiting on a human, across every saved board, most recent first. */
function collectAwaiting(boards: BoardRow[], summaries: Record<string, BoardSummary>) {
  return boards
    .flatMap((b) => (summaries[b.id]?.awaitingReview ?? []).map((task) => ({ ...task, boardId: b.id, boardName: b.name })))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function AwaitingList({
  boards,
  summaries,
  limit,
  onOpenBoard,
}: {
  boards: BoardRow[];
  summaries: Record<string, BoardSummary>;
  limit?: number;
  onOpenBoard: (id: string) => void;
}) {
  const items = collectAwaiting(boards, summaries).slice(0, limit ?? Number.POSITIVE_INFINITY);
  if (items.length === 0) return <div className={styles.waitingEmpty}>{t("shell.inbox.empty")}</div>;
  return (
    <div className={styles.inboxList}>
      {items.map((item) => (
        <button key={item.taskId} type="button" className={styles.inboxItem} onClick={() => onOpenBoard(item.boardId)}>
          <span className={styles.inboxTitle}>
            <span className={styles.inboxDot} />
            {firstLine(item.title) || t("home.task.untitled")}
          </span>
          <span className={styles.inboxMeta}>{t("home.review.meta", { session: item.boardName, when: formatRelative(item.updatedAt) })}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Sessions — the home screen of the new shell (telas 3 and 4). Lists the
 * sessions grouped by project, offers the most recent one as "Continue", and
 * hosts create/edit through SessionModal. Search, sort and the grid/list
 * toggle are local view state; Ctrl K focuses the search.
 */
export function Home({
  boards,
  boardCounts,
  summaries,
  backgroundStatus,
  onStopBoard,
  workspaceRoot,
  defaultCwd,
  onChangeRoot,
  onNavigateRoot,
  onOpenBoard,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onOpenInbox,
}: {
  boards: BoardRow[];
  boardCounts: Record<string, BoardCounts>;
  summaries: Record<string, BoardSummary>;
  /** Per-session background state (running / N agents / waiting on you). `null`
   * while the projection has not loaded — the cards simply show no indicator. */
  backgroundStatus: BoardBackgroundStatus | null;
  /** Terminates a session's processes (the "Stop session" action). */
  onStopBoard: (id: string) => void;
  workspaceRoot: string;
  defaultCwd: string;
  onChangeRoot: () => void;
  onNavigateRoot: (path: string) => void;
  onOpenBoard: (id: string) => void;
  onCreateBoard: (name: string, cwd: string, template: SessionTemplate) => void;
  onUpdateBoard: (id: string, name: string, cwd: string) => void;
  onDeleteBoard: (id: string) => void;
  onOpenInbox: () => void;
}) {
  const [modal, setModal] = useState<ModalState>(null);
  /** Session awaiting confirmation before it is stopped (an agent is running
   * or waiting). `null` = no confirm open. */
  const [stopTarget, setStopTarget] = useState<BoardRow | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [view, setView] = useState<ViewMode>("grid");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const homeDir = window.system.homeDir;
  const providers = useAvailableAgentProviders();
  const providerLabel = useMemo(() => new Map(providers.map((p) => [p.id, p.label])), [providers]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const mostRecentId = recentBadgeId(boards);
  const filtered = useMemo(() => filterSessions(boards, query), [boards, query]);
  const groups = useMemo(() => {
    const grouped = groupByProject(filtered);
    return sort === "name" ? sortGroupsByName(grouped) : grouped;
  }, [filtered, sort]);

  const folderCount = new Set(boards.map((b) => b.project || b.cwd)).size;
  const mostRecent = pickContinueBoard(boards);
  const mostRecentSummary = mostRecent ? summaries[mostRecent.id] : undefined;
  const awaitingTotal = boards.reduce((n, b) => n + (summaries[b.id]?.tasksAwaitingReview ?? 0), 0);

  const sessionsPart = boards.length === 1 ? t("home.sessions.countOne") : t("home.sessions.count", { n: boards.length });
  const foldersPart = folderCount === 1 ? t("home.folders.countOne") : t("home.folders.count", { n: folderCount });
  const tasksPart = awaitingTotal > 0 ? ` · ${awaitingTotal === 1 ? t("home.tasks.waitingOne") : t("home.tasks.waiting", { n: awaitingTotal })}` : "";

  function openCreate(cwd?: string) {
    setModal({ mode: "create", cwd });
  }

  /** "Stop session": confirm only when an agent is working or waiting on this
   * session (nothing in progress to lose otherwise). */
  function requestStop(board: BoardRow) {
    const liveAgents = backgroundStatus?.boards[board.id]?.agents ?? 0;
    if (decideStopSessionConfirm(liveAgents)) setStopTarget(board);
    else onStopBoard(board.id);
  }

  return (
    <div className={`${styles.page} home`}>
      <div className={`${styles.header} home-header`}>
        <div className={styles.titleCol}>
          <h1 className={styles.h1}>{t("home.sessions")}</h1>
          <div className={styles.subtitle}>
            {t("home.sessions.subtitle", { s: sessionsPart, f: foldersPart })}
            {tasksPart}
          </div>
        </div>
        <label className={styles.search}>
          <span className={styles.searchIcon}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          </span>
          <input
            ref={searchRef}
            className={styles.searchInput}
            type="search"
            placeholder={t("home.search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className={styles.kbd}>Ctrl K</span>
        </label>
        <button type="button" className="primary" onClick={() => openCreate()}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M7 2.5v9M2.5 7h9" />
          </svg>
          {t("home.newSessionPlain")}
        </button>
      </div>

      {boards.length === 0 ? (
        <div className={`${styles.empty} home-empty`}>
          <div className={styles.emptyIcon}>
            <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
              <rect x="2" y="2" width="5" height="5" rx="1.2" />
              <rect x="9" y="2" width="5" height="5" rx="1.2" />
              <rect x="2" y="9" width="5" height="5" rx="1.2" />
              <path d="M11.5 9.5v4M9.5 11.5h4" />
            </svg>
          </div>
          <div>
            <h2 className={styles.emptyTitle}>{t("home.empty.title")}</h2>
            <p className={styles.emptyText}>{t("home.empty.text")}</p>
          </div>
          <div className={styles.emptyActions}>
            <button type="button" className="primary" onClick={() => openCreate()}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M7 2.5v9M2.5 7h9" />
              </svg>
              {t("home.createFirst")}
            </button>
            <button type="button" className={styles.ghostBtn} onClick={onChangeRoot}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M1.8 4.5a1 1 0 0 1 1-1h3.4l1.4 1.6h5.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
              </svg>
              {t("home.openFolder")}
            </button>
          </div>
          <div className={styles.noteGrid}>
            <div className={styles.note}>
              <span className={styles.noteTitle}>{t("home.empty.tip.workhome.title")}</span>
              <span className={styles.noteText}>{t("home.empty.tip.workhome.text")}</span>
            </div>
            <div className={styles.note}>
              <span className={styles.noteTitle}>{t("home.empty.tip.cli.title")}</span>
              <span className={styles.noteText}>{t("home.empty.tip.cli.text")}</span>
            </div>
            <div className={styles.note}>
              <span className={styles.noteTitle}>{t("home.empty.tip.cycle.title")}</span>
              <span className={styles.noteText}>{t("home.empty.tip.cycle.text")}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          <section className={styles.continueRow} aria-label={t("home.continue")}>
            {mostRecent ? (
              <div className={styles.continueHero}>
                <div className={styles.eyebrowRow}>
                  <span className={styles.eyebrow}>{t("home.continue").toUpperCase()}</span>
                  <span className={styles.eyebrowMeta}>
                    {mostRecent.last_accessed_at
                      ? t("home.accessed", { when: formatRelative(mostRecent.last_accessed_at) })
                      : t("home.neverAccessed")}
                  </span>
                </div>
                <div>
                  <div className={styles.heroName}>{mostRecent.name}</div>
                  <div className={styles.heroPath}>{abbreviateHome(mostRecent.cwd, homeDir)}</div>
                </div>
                {mostRecentSummary && mostRecentSummary.providers.length > 0 ? (
                  <div className={styles.chips}>
                    {mostRecentSummary.providers.map((p) => (
                      <span key={p.provider} className={styles.chip}>
                        <span className={styles.pdot} style={{ background: providerColor(p.provider) }} />
                        {providerLabel.get(p.provider) ?? p.provider}
                        {p.count > 1 ? ` ×${p.count}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className={styles.heroMeta}>
                  <span>{t("home.agentsCount", { agents: boardCounts[mostRecent.id]?.agents ?? 0 })}</span>
                  {mostRecentSummary && mostRecentSummary.tasksRunning > 0 ? <span>{t("home.tasksRunning", { n: mostRecentSummary.tasksRunning })}</span> : null}
                  {mostRecentSummary && mostRecentSummary.tasksAwaitingReview > 0 ? (
                    <span className={styles.heroWarn}>{t("home.tasksReview", { n: mostRecentSummary.tasksAwaitingReview })}</span>
                  ) : null}
                  <span className={styles.heroActions}>
                    <button type="button" className={styles.ghostBtn} onClick={() => onOpenBoard(mostRecent.id)}>
                      {t("home.viewTasks")}
                    </button>
                    <button type="button" className="primary" onClick={() => onOpenBoard(mostRecent.id)}>
                      {t("home.openSession")}
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" />
                      </svg>
                    </button>
                  </span>
                </div>
              </div>
            ) : null}
            <div className={styles.waitingCard}>
              <div className={styles.waitingHead}>
                {t("shell.inbox")}
                {awaitingTotal > 0 ? (
                  <button type="button" className={styles.waitingHeadLink} onClick={onOpenInbox}>
                    {t("home.viewAll")}
                  </button>
                ) : null}
              </div>
              <AwaitingList boards={boards} summaries={summaries} limit={3} onOpenBoard={onOpenBoard} />
            </div>
          </section>

          <section className={styles.all} aria-label={t("home.allSessions")}>
            <div className={styles.allHead}>
              <h2 className={styles.allTitle}>{t("home.allSessions")}</h2>
              <button type="button" className={styles.sortBtn} onClick={() => setSort((s) => (s === "recent" ? "name" : "recent"))}>
                {sort === "recent" ? t("home.sort.recent") : t("home.sort.name")}
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M4 5.5l3 3 3-3" />
                </svg>
              </button>
              <div className={styles.viewToggle}>
                <button
                  type="button"
                  className={`${styles.viewBtn}${view === "grid" ? ` ${styles.viewBtnOn}` : ""}`}
                  aria-label={t("home.view.grid")}
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                    <rect x="2" y="2" width="5" height="5" rx="1" />
                    <rect x="9" y="2" width="5" height="5" rx="1" />
                    <rect x="2" y="9" width="5" height="5" rx="1" />
                    <rect x="9" y="9" width="5" height="5" rx="1" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`${styles.viewBtn}${view === "list" ? ` ${styles.viewBtnOn}` : ""}`}
                  aria-label={t("home.view.list")}
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
                  </svg>
                </button>
              </div>
            </div>

            {groups.map(([project, group]) => (
              <div key={project} className={styles.group}>
                <div className={styles.groupHead}>
                  <span className={`${styles.groupLabel} home-group-label`}>{project.toUpperCase()}</span>
                  <span className={styles.groupPath}>{abbreviateHome(group[0].cwd, homeDir)}</span>
                </div>
                <div className={`${styles.grid}${view === "list" ? ` ${styles.gridList}` : ""}`}>
                  {group.map((b) => {
                    const counts = boardCounts[b.id];
                    const summary = summaries[b.id];
                    const bg = backgroundStatus?.boards[b.id];
                    const isRecent = b.id === mostRecentId;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`${styles.card} home-session-card`}
                        title={b.cwd || undefined}
                        onClick={() => onOpenBoard(b.id)}
                      >
                        <span className={styles.cardTop}>
                          <span className={`${styles.cardName} home-session-name`}>{b.name}</span>
                          {isRecent ? <span className={`${styles.recent} home-session-recent`}>{t("home.recent")}</span> : null}
                        </span>
                        {summary && summary.providers.length > 0 ? (
                          <span className={styles.cardDots}>
                            {summary.providers.flatMap((p) =>
                              Array.from({ length: Math.min(p.count, 4) }, (_, i) => (
                                <span key={`${p.provider}-${i}`} className={styles.pdotCard} style={{ background: providerColor(p.provider) }} />
                              )),
                            )}
                          </span>
                        ) : null}
                        <span className={`${styles.cardCounts} home-session-counts`}>
                          {counts ? t("home.agentsCount", { agents: counts.agents }) : t("home.agentsZero")}
                        </span>
                        <span
                          className={`${styles.cardDates} home-session-dates`}
                          title={
                            t("home.created", { when: new Date(b.created_at).toLocaleString(getLocale()) }) +
                            (b.last_accessed_at
                              ? `\n${t("home.accessed", { when: new Date(b.last_accessed_at).toLocaleString(getLocale()) })}`
                              : "")
                          }
                        >
                          {b.last_accessed_at
                            ? t("home.accessed", { when: formatRelative(b.last_accessed_at) })
                            : t("home.neverAccessed")}
                        </span>
                        {bg?.alive ? (
                          <span className={`${styles.bgStatus} home-session-background`} data-part="session-background">
                            <span className={styles.bgDot} data-awaiting={bg.awaiting > 0 ? "true" : undefined} />
                            {bg.agents > 0
                              ? bg.agents === 1
                                ? t("home.session.backgroundOne")
                                : t("home.session.background", { n: bg.agents })
                              : t("home.session.backgroundIdle")}
                            {bg.awaiting > 0 ? <span className={styles.bgAwaiting}>{t("home.session.awaiting")}</span> : null}
                          </span>
                        ) : null}
                        <span
                          className={`${styles.edit} home-session-edit`}
                          data-role="edit-session"
                          title={t("home.editSession")}
                          onClick={(e) => {
                            e.stopPropagation();
                            setModal({ mode: "edit", board: b });
                          }}
                        >
                          <Icon name="pen" size={13} />
                        </span>
                        <span
                          className={`${styles.stop} home-session-stop`}
                          data-role="stop-session"
                          role="button"
                          tabIndex={0}
                          title={t("home.session.stop")}
                          onClick={(e) => {
                            e.stopPropagation();
                            requestStop(b);
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                            <rect x="3" y="3" width="6" height="6" rx="1" />
                          </svg>
                        </span>
                      </button>
                    );
                  })}
                  <button type="button" className={styles.newCard} onClick={() => openCreate(group[0].cwd)}>
                    <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <path d="M7 2.5v9M2.5 7h9" />
                    </svg>
                    {t("home.newInFolder")}
                  </button>
                </div>
              </div>
            ))}
          </section>
        </div>
      )}

      {modal?.mode === "create" && (
        <SessionModal
          mode="create"
          defaultCwd={modal.cwd ?? defaultCwd}
          workspaceRoot={workspaceRoot}
          onChangeRoot={onChangeRoot}
          onNavigateRoot={onNavigateRoot}
          onCreate={onCreateBoard}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.mode === "edit" && (
        <SessionModal
          mode="edit"
          board={boards.find((b) => b.id === modal.board.id) ?? modal.board}
          workspaceRoot={workspaceRoot}
          onChangeRoot={onChangeRoot}
          onNavigateRoot={onNavigateRoot}
          canDelete={boards.length > 1}
          onSave={onUpdateBoard}
          onDelete={onDeleteBoard}
          onClose={() => setModal(null)}
        />
      )}
      {stopTarget && (
        <ConfirmModal
          title={t("home.session.stopTitle")}
          message={t("home.session.stopMessage", { n: backgroundStatus?.boards[stopTarget.id]?.agents ?? 0 })}
          confirmLabel={t("home.session.stop")}
          danger
          onConfirm={() => {
            onStopBoard(stopTarget.id);
            setStopTarget(null);
          }}
          onCancel={() => setStopTarget(null)}
        />
      )}
    </div>
  );
}
