import { Fragment, useEffect, useMemo, useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type { BoardRow, BoardCounts, CloudStatusInfo, InboxSnapshotInfo } from "../../preload/index";
import type { SessionTemplate } from "./useBoardStore";
import { Home } from "./Home";
import { ProfileSelector } from "./ProfileSelector";
import { WorkHomePage } from "./WorkHomePage";
import { TeamPage } from "./TeamPage";
import { InboxPage } from "./InboxPage";
import { CloudLinkPanel } from "./CloudLinkPanel";
import { useBoardSummaries, useBoardBackgroundStatus } from "./useBoardSummaries";
import { consumeTeamBoardFocus } from "./board-quick-task-decisions";
import { setTeamSub, useTeamNav, type TeamSub } from "./team-nav";
import { hasCloudAccount } from "./account-mode-decision";
import { accountIdentity, formatStaleStamp, isSessionOffline, readOfflineAccount, statusIdentity } from "./account-display-decision";
import { getLocale } from "../../shared/i18n";
import {
  scopeLanding,
  scopeNavSections,
  sectionAllowedInScope,
  teamSectionVisible,
  type AccountProfileView,
  type AccountScope,
} from "./account-scope-decision";
import type { AccountProfilesState } from "./account-scope";
import { AccountSessionImport } from "./AccountSessionImport";
import styles from "./Shell.module.css";

const TEAM_SUB_LABEL: Record<TeamSub, MessageKey> = {
  overview: "teamTask.subnav.overview",
  board: "teamTask.subnav.board",
  members: "teamTask.subnav.members",
  home: "teamTask.subnav.home",
  import: "teamTask.subnav.import",
  integrations: "teamTask.subnav.integrations",
  audit: "teamTask.subnav.audit",
  settings: "teamAdmin.subnav.settings",
};

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
  scope,
  onScopeChange,
  accountProfiles,
  accountProfile,
  onPickAccountProfile,
  sessionBoards,
  localBoards,
  onImportBoards,
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
  /** The scope shared by the switcher and the content. */
  scope: AccountScope;
  onScopeChange: (next: AccountScope) => void;
  /** The account's profiles (Pro, one per team) and the one in view. */
  accountProfiles: AccountProfilesState;
  accountProfile: AccountProfileView | null;
  onPickAccountProfile: (id: string) => void;
  /** The sessions of the view in front of the user (`boards` is every session, for the team screens). */
  sessionBoards: BoardRow[];
  /** The sessions kept on this machine (owned by no account profile): what an import can bring. */
  localBoards: BoardRow[];
  onImportBoards: (ids: readonly string[]) => void;
  initialSection?: ShellSection;
}) {
  const [section, setSection] = useState<ShellSection>(
    sectionAllowedInScope(initialSection, scope, { team: false }) ? initialSection : scopeLanding(scope),
  );
  const [hasInvite, setHasInvite] = useState(false);
  const [inboxSnap, setInboxSnap] = useState<InboxSnapshotInfo | null>(null);
  const teamNav = useTeamNav();
  const [teamFocus, setTeamFocus] = useState<{ teamId: string; taskId?: string; unassigned?: boolean } | null>(null);

  const loggedIn = hasCloudAccount(cloud);
  // A saved session waiting for the connection: the account is still known from the machine.
  const offlineAccount = readOfflineAccount(cloud);
  const accountOffline = !loggedIn && offlineAccount !== null;
  const accountLabel = cloud?.state === "logged-in" ? cloud.account.displayName : (offlineAccount?.account.displayName ?? null);
  const offlineStamp = offlineAccount ? formatStaleStamp(offlineAccount.savedAtMs, getLocale()) : "";
  // One identity, read once, for the switcher.
  const identity = statusIdentity(cloud)?.identity ?? (offlineAccount ? accountIdentity(offlineAccount.account).identity : "");
  const sessionOffline = isSessionOffline(cloud);
  const inTeamProfile = scope === "account" && teamSectionVisible(accountProfile, accountProfiles.profiles, accountProfiles.status === "ok");
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!loggedIn) return;
    const focus = consumeTeamBoardFocus();
    if (focus) {
      setTeamFocus({ teamId: focus.teamId, unassigned: focus.unassigned });
      onScopeChange("account");
      setSection("team");
    }
  }, [loggedIn, onScopeChange]);

  // A section that is not part of the scope in view gives way to the scope's landing.
  useEffect(() => {
    if (!sectionAllowedInScope(section, scope, { team: inTeamProfile })) setSection(scopeLanding(scope));
  }, [scope, section, inTeamProfile]);

  useEffect(() => {
    if (!loggedIn) {
      setHasInvite(false);
      return;
    }
    void window.team
      .pendingInvite()
      .then((r) => setHasInvite(r.token !== null))
      .catch(() => {});
    return window.team.onInvite(() => setHasInvite(true));
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn || !window.inbox?.snapshot) return;
    void window.inbox
      .snapshot()
      .then(setInboxSnap)
      .catch(() => {});
    const offSnap = window.inbox.onSnapshot(setInboxSnap);
    const offNav = window.inbox.onNavigate((item) => {
      onScopeChange("account");
      setSection("inbox");
      if (item.source === "local" && item.boardId) onOpenBoard(item.boardId);
      else if (item.teamId && item.taskId) {
        setTeamFocus({ teamId: item.teamId, taskId: item.taskId });
        setSection("team");
      }
    });
    return () => {
      offSnap();
      offNav();
    };
  }, [onOpenBoard, onScopeChange, loggedIn]);

  const summaries = useBoardSummaries(boards);
  const background = useBoardBackgroundStatus(boards);
  // The account inbox counts what comes from the account; local review rows belong to the local scope.
  const inboxBadge = inboxSnap
    ? inboxSnap.items.filter((item) => item.source === "team").length
    : 0;

  const items = useMemo(() => {
    const byId: Record<
      ShellSection,
      { id: ShellSection; label: string; count?: number; sub?: string; badge?: number }
    > = {
      sessions: { id: "sessions", label: t("shell.sessions"), count: sessionBoards.length },
      inbox: {
        id: "inbox",
        label: t("shell.inbox"),
        badge: inboxBadge > 0 ? inboxBadge : hasInvite ? 1 : undefined,
      },
      workhome: { id: "workhome", label: t("shell.workhome"), sub: t("shell.workhome.synced") },
      team: { id: "team", label: t("shell.team"), sub: t("shell.team.withAccount") },
      stats: { id: "stats", label: t("shell.stats") },
      account: { id: "account", label: t("shell.account") },
    };
    return scopeNavSections(scope, { team: inTeamProfile }).map((id) => byId[id]);
  }, [sessionBoards.length, hasInvite, inboxBadge, scope, inTeamProfile]);

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <ProfileSelector
          onOpenSettings={onOpenSettings}
          loggedIn={loggedIn}
          sessionOffline={sessionOffline}
          offlineSinceMs={offlineAccount?.savedAtMs ?? null}
          onManageAccount={() => {
            onScopeChange("account");
            setSection("account");
          }}
          accountName={accountLabel}
          accountIdentity={identity}
          scope={scope}
          onScopeChange={onScopeChange}
          accountProfiles={accountProfiles}
          accountProfile={accountProfile}
          onPickAccountProfile={onPickAccountProfile}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
        />

        <nav className={styles.nav} aria-label={t("shell.sections")}>
          {items.map((item) => (
            <Fragment key={item.id}>
            <button
              type="button"
              data-section={item.id}
              className={`${styles.navItem}${section === item.id ? ` ${styles.navItemOn}` : ""}${item.id === "team" && section === "team" && teamNav.available.length > 0 ? ` ${styles.navItemParent}` : ""}`}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <NavIcon name={item.id} />
              <span className={styles.navLabel}>{item.label}</span>
              {item.count !== undefined ? <span className={styles.navCount}>{item.count}</span> : null}
              {item.sub !== undefined ? <span className={styles.navSub}>{item.sub}</span> : null}
              {item.badge !== undefined ? <span className={styles.badge}>{item.badge}</span> : null}
            </button>
            {item.id === "team" && section === "team"
              ? teamNav.available.map((sub) => (
                  <button
                    key={sub}
                    type="button"
                    data-team-sub={sub}
                    data-part={sub === "import" ? "team-open-import" : sub === "integrations" ? "team-open-integrations" : undefined}
                    className={`${styles.subItem}${teamNav.sub === sub ? ` ${styles.subItemOn}` : ""}`}
                    aria-current={teamNav.sub === sub ? "page" : undefined}
                    onClick={() => setTeamSub(sub)}
                  >
                    {t(TEAM_SUB_LABEL[sub])}
                  </button>
                ))
              : null}
            </Fragment>
          ))}
        </nav>

        <span className={styles.spacer} />

        {section === "inbox" ? (
          <div className={styles.notifPrefs} data-role="inbox-prefs">
            <span className={styles.notifPrefsTitle}>{t("inbox.prefs.title")}</span>
            <label className={styles.notifPrefsLabel}>
              <input
                type="checkbox"
                checked={inboxSnap?.prefs.inApp ?? true}
                onChange={(e) => {
                  void window.inbox?.setPrefs({ inApp: e.target.checked }).then((res) => {
                    if (res.ok) setInboxSnap((prev) => (prev ? { ...prev, prefs: res.prefs } : prev));
                  });
                }}
              />
              {t("inbox.prefs.inApp")}
            </label>
            <label className={styles.notifPrefsLabel}>
              <input
                type="checkbox"
                checked={inboxSnap?.prefs.system ?? true}
                onChange={(e) => {
                  void window.inbox?.setPrefs({ system: e.target.checked }).then((res) => {
                    if (res.ok) setInboxSnap((prev) => (prev ? { ...prev, prefs: res.prefs } : prev));
                  });
                }}
              />
              {t("inbox.prefs.system")}
            </label>
            <label className={styles.notifPrefsLabel}>
              <input
                type="checkbox"
                checked={inboxSnap?.prefs.dailyDigest ?? false}
                onChange={(e) => {
                  void window.inbox?.setPrefs({ dailyDigest: e.target.checked }).then((res) => {
                    if (res.ok) setInboxSnap((prev) => (prev ? { ...prev, prefs: res.prefs } : prev));
                  });
                }}
              />
              {t("inbox.prefs.dailyDigest")}
            </label>
          </div>
        ) : null}

        {section !== "inbox" ? (
          <button type="button" className={`${styles.navItem} ${styles.settingsItem}`} onClick={onOpenSettings}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
            </svg>
            <span className={styles.navLabel}>{t("shell.settings")}</span>
          </button>
        ) : null}
      </aside>

      <main className={styles.main}>
        {section === "sessions" ? (
          <Home
            boards={sessionBoards}
            contextPill={
              scope === "account" && accountProfile
                ? accountProfile.kind === "team"
                  ? accountProfile.name
                  : t("account.pill.personal", { name: accountProfile.name })
                : undefined
            }
            staleNotice={scope === "account" && accountOffline ? t("account.offline.home", { when: offlineStamp }) : undefined}
            accountEmpty={
              scope === "account"
                ? { onImport: localBoards.length > 0 ? () => setImportOpen(true) : undefined }
                : undefined
            }
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
          />
        ) : accountOffline && (section === "workhome" || section === "team" || section === "inbox" || section === "account") ? (
          <OfflineSection when={offlineStamp} />
        ) : loggedIn && section === "workhome" ? (
          <WorkHomePage />
        ) : loggedIn && section === "team" ? (
          <TeamPage
            boards={boards.map((b) => ({ id: b.id, name: b.name }))}
            initialTeamId={teamFocus?.teamId ?? (accountProfile?.kind === "team" ? (accountProfile.teamId ?? undefined) : undefined)}
            initialTaskId={teamFocus?.taskId}
            initialUnassigned={teamFocus?.unassigned === true}
          />
        ) : loggedIn && section === "account" ? (
          <div className={styles.page}>
            <h1 className={styles.sectionTitle}>{t("shell.account")}</h1>
            <div className={styles.sectionSub} data-role="account-page-identity">
              {[accountLabel, identity].filter((part) => part && part !== "").join(" · ") || t("shell.signIn.action")}
            </div>
            <CloudLinkPanel />
            <div>
              <button type="button" className={styles.ghostBtn} onClick={onSignOut}>
                {t("cloud.signOut")}
              </button>
            </div>
          </div>
        ) : loggedIn && section === "inbox" ? (
          <InboxPage
            accountOnly
            boards={boards.map((b) => ({ id: b.id, name: b.name }))}
            onOpenBoard={onOpenBoard}
            onOpenTeamTask={(teamId, taskId) => {
              setTeamFocus({ teamId, taskId });
              setSection("team");
            }}
          />
        ) : (
          <InfoSection boardCount={sessionBoards.length} />
        )}
      </main>
      {importOpen ? (
        <AccountSessionImport
          boards={localBoards}
          targetName={accountProfile?.name ?? ""}
          onImport={(ids) => {
            onImportBoards(ids);
            setImportOpen(false);
          }}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** An account section that needs the API, while the connection is missing. The sessions stay usable. */
function OfflineSection({ when }: { when: string }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className={styles.page} data-role="account-offline-section">
      <h1 className={styles.sectionTitle}>{t("account.offline.section.title")}</h1>
      <div className={styles.sectionSub}>{t("account.offline.section.text", { when })}</div>
      <div>
        <button
          type="button"
          className={styles.ghostBtn}
          data-role="account-section-retry"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void window.cloud.retry().finally(() => setRetrying(false));
          }}
        >
          {t("account.retry")}
        </button>
      </div>
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
