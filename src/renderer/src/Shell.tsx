import { useEffect, useState } from "react";
import { t } from "../../shared/i18n";
import type { BoardRow, BoardCounts, CloudStatusInfo } from "../../preload/index";
import type { SessionTemplate } from "./useBoardStore";
import { Home, AwaitingList } from "./Home";
import { ProfileSelector } from "./ProfileSelector";
import { WorkHomePage } from "./WorkHomePage";
import { TeamPage } from "./TeamPage";
import { CloudLinkPanel } from "./CloudLinkPanel";
import { useBoardSummaries, useBoardBackgroundStatus } from "./useBoardSummaries";
import styles from "./Shell.module.css";

export type ShellSection = "sessions" | "inbox" | "workhome" | "team" | "stats" | "account";

function NavIcon({ name }: { name: ShellSection }) {
  const stroke = "currentColor";
  if (name === "sessions") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <rect x="2" y="2" width="5" height="5" rx="1.2" />
        <rect x="9" y="2" width="5" height="5" rx="1.2" />
        <rect x="2" y="9" width="5" height="5" rx="1.2" />
        <rect x="9" y="9" width="5" height="5" rx="1.2" />
      </svg>
    );
  }
  if (name === "inbox") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3.2l2 1.3" />
      </svg>
    );
  }
  if (name === "workhome") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <path d="M2.5 7.2L8 2.8l5.5 4.4V13a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8z" />
        <path d="M6.3 13.8V9.6h3.4v4.2" />
      </svg>
    );
  }
  if (name === "team") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
        <circle cx="5.8" cy="5.6" r="2.3" />
        <circle cx="11" cy="6.3" r="1.8" />
        <path d="M1.8 13c.4-2.3 2-3.6 4-3.6s3.6 1.3 4 3.6M10 9.6c1.9 0 3.4 1.1 3.9 3.4" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 13.5V8.5M6.2 13.5V4.5M9.8 13.5V7M13.5 13.5V2.5" />
    </svg>
  );
}

function initials(text: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * The new shell: a fixed sidebar (profile, sections, account, settings) and a
 * content area that renders the active section. Sessions is the default; the
 * other sections reuse the logic that already exists for teams and the work
 * home.
 */
export function Shell({
  boards,
  boardCounts,
  workspaceRoot,
  defaultCwd,
  cloud,
  onChangeRoot,
  onNavigateRoot,
  onOpenBoard,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onStopBoard,
  onOpenSettings,
  onSignIn,
  onSignOut,
  initialSection = "sessions",
}: {
  boards: BoardRow[];
  boardCounts: Record<string, BoardCounts>;
  workspaceRoot: string;
  defaultCwd: string;
  cloud: CloudStatusInfo | null;
  onChangeRoot: () => void;
  onNavigateRoot: (path: string) => void;
  onOpenBoard: (id: string) => void;
  onCreateBoard: (name: string, cwd: string, template: SessionTemplate) => void;
  onUpdateBoard: (id: string, name: string, cwd: string) => void;
  onDeleteBoard: (id: string) => void;
  onStopBoard: (id: string) => void;
  onOpenSettings: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  initialSection?: ShellSection;
}) {
  const [section, setSection] = useState<ShellSection>(initialSection);
  const [hasInvite, setHasInvite] = useState(false);

  useEffect(() => {
    void window.team
      .pendingInvite()
      .then((r) => setHasInvite(r.token !== null))
      .catch(() => {});
    return window.team.onInvite(() => setHasInvite(true));
  }, []);

  const loggedIn = cloud?.state === "logged-in";
  const accountLabel = cloud?.state === "logged-in" ? cloud.account.displayName : null;
  const summaries = useBoardSummaries(boards);
  const background = useBoardBackgroundStatus(boards);
  const awaitingTotal = boards.reduce((n, b) => n + (summaries[b.id]?.tasksAwaitingReview ?? 0), 0);

  const items: { id: ShellSection; label: string; count?: number; sub?: string; badge?: number }[] = [
    { id: "sessions", label: t("shell.sessions"), count: boards.length },
    { id: "inbox", label: t("shell.inbox"), badge: awaitingTotal > 0 ? awaitingTotal : hasInvite ? 1 : undefined },
    { id: "workhome", label: t("shell.workhome"), sub: loggedIn ? t("shell.workhome.synced") : t("shell.workhome.local") },
    { id: "team", label: t("shell.team"), sub: loggedIn ? t("shell.team.withAccount") : undefined },
    { id: "stats", label: t("shell.stats") },
  ];

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <ProfileSelector onOpenSettings={onOpenSettings} loggedIn={loggedIn} />

        <nav className={styles.nav} aria-label={t("shell.sections")}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              data-section={item.id}
              className={`${styles.navItem}${section === item.id ? ` ${styles.navItemOn}` : ""}`}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <NavIcon name={item.id} />
              <span className={styles.navLabel}>{item.label}</span>
              {item.count !== undefined ? <span className={styles.navCount}>{item.count}</span> : null}
              {item.sub !== undefined ? <span className={styles.navSub}>{item.sub}</span> : null}
              {item.badge !== undefined ? <span className={styles.badge}>{item.badge}</span> : null}
            </button>
          ))}
        </nav>

        <span className={styles.spacer} />

        {loggedIn ? (
          <button type="button" className={styles.account} data-role="account" onClick={() => setSection("account")} title={t("shell.account")}>
            <span className={styles.accountAvatar}>{accountLabel ? initials(accountLabel) : "?"}</span>
            <span className={styles.accountText}>
              <span className={styles.accountName}>{accountLabel}</span>
              <span className={styles.accountSub}>{t("shell.accountSub")}</span>
            </span>
          </button>
        ) : (
          <div className={styles.signInCard}>
            <div className={styles.signInTitle}>{t("shell.signIn.title")}</div>
            <div className={styles.signInDesc}>{t("shell.signIn.desc")}</div>
            <button type="button" className={`${styles.primaryBtn} ${styles.signInBtn}`} data-role="sign-in" onClick={onSignIn}>
              {t("shell.signIn.action")}
            </button>
          </div>
        )}

        <button
          type="button"
          className={`${styles.navItem} ${styles.settingsItem}`}
          onClick={onOpenSettings}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
          </svg>
          <span className={styles.navLabel}>{t("shell.settings")}</span>
        </button>
      </aside>

      <main className={styles.main}>
        {section === "sessions" ? (
          <Home
            boards={boards}
            boardCounts={boardCounts}
            summaries={summaries}
            backgroundStatus={background}
            onStopBoard={onStopBoard}
            workspaceRoot={workspaceRoot}
            defaultCwd={defaultCwd}
            onChangeRoot={onChangeRoot}
            onNavigateRoot={onNavigateRoot}
            onOpenBoard={onOpenBoard}
            onCreateBoard={onCreateBoard}
            onUpdateBoard={onUpdateBoard}
            onDeleteBoard={onDeleteBoard}
            onOpenInbox={() => setSection("inbox")}
          />
        ) : section === "workhome" ? (
          <WorkHomePage />
        ) : section === "team" ? (
          <TeamPage boards={boards.map((b) => ({ id: b.id, name: b.name }))} />
        ) : section === "account" ? (
          <div className={styles.page}>
            <div className={styles.sectionSub}>{cloud?.state === "logged-in" ? cloud.account.displayName : t("shell.signIn.action")}</div>
            <CloudLinkPanel />
            {loggedIn ? (
              <div>
                <button type="button" className={styles.ghostBtn} onClick={onSignOut}>
                  {t("cloud.signOut")}
                </button>
              </div>
            ) : null}
          </div>
        ) : section === "inbox" ? (
          <div className={styles.page}>
            <h1 className={styles.sectionTitle}>{t("shell.inbox")}</h1>
            <AwaitingList boards={boards} summaries={summaries} onOpenBoard={onOpenBoard} />
          </div>
        ) : (
          <InfoSection boardCount={boards.length} />
        )}
      </main>
    </div>
  );
}

function InfoSection({ boardCount }: { boardCount: number }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.sectionTitle}>{t("shell.stats")}</h1>
      <div className={styles.sectionSub}>{t("shell.stats.sessions", { n: boardCount })}</div>
    </div>
  );
}
