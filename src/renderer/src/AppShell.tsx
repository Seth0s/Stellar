import { useCallback, useEffect, useState } from "react";
import { setLocale, getLocale, type Locale } from "../../shared/i18n";
import type { BoardRow, BoardCounts, CloudStatusInfo, ProfilesState } from "../../preload/index";
import type { SessionTemplate } from "./useBoardStore";
import { Boot } from "./Boot";
import { FirstRun } from "./FirstRun";
import { LoginScreen } from "./LoginScreen";
import { InviteDialog } from "./InviteDialog";
import { Shell } from "./Shell";
import { shouldShowFirstRun } from "./home-decisions";

function firstRunKey(profileId: string | null): string {
  return `ac.firstRun.${profileId ?? "default"}`;
}

type Phase = "boot" | "firstRun" | "login" | "ready";

/**
 * Home controller. Decides, in order: the cold-start screen while the app
 * comes up; the first-run screen for a profile with no sessions, no account
 * and no recorded choice; the login screen; otherwise the shell.
 */
export function AppShell({
  loaded,
  boards,
  boardCounts,
  workspaceRoot,
  defaultCwd,
  onChangeRoot,
  onNavigateRoot,
  onOpenBoard,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onStopBoard,
  onOpenSettings,
}: {
  loaded: boolean;
  boards: BoardRow[];
  boardCounts: Record<string, BoardCounts>;
  workspaceRoot: string;
  defaultCwd: string;
  onChangeRoot: () => void;
  onNavigateRoot: (path: string) => void;
  onOpenBoard: (id: string) => void;
  onCreateBoard: (name: string, cwd: string, template: SessionTemplate) => void;
  onUpdateBoard: (id: string, name: string, cwd: string) => void;
  onDeleteBoard: (id: string) => void;
  onStopBoard: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const [booted, setBooted] = useState(false);
  const [phase, setPhase] = useState<Phase>("boot");
  const [profiles, setProfiles] = useState<ProfilesState | null>(null);
  const [cloud, setCloud] = useState<CloudStatusInfo | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [locale, setLocaleState] = useState<Locale>(getLocale());

  useEffect(() => {
    void window.profiles.list().then(setProfiles).catch(() => setProfiles(null));
    void window.cloud.status().then(setCloud).catch(() => {});
    const off = window.cloud.onStatusChanged(setCloud);
    void window.team
      .pendingInvite()
      .then((r) => {
        if (r.token) setInviteToken(r.token);
      })
      .catch(() => {});
    const offInvite = window.team.onInvite((payload) => setInviteToken(payload.token));
    return () => {
      off();
      offInvite();
    };
  }, []);

  const profileId = profiles?.activeProfileId ?? null;
  const profileName = profiles?.profiles.find((p) => p.isActive)?.name ?? null;

  const onBootReady = useCallback(() => setBooted(true), []);

  useEffect(() => {
    if (!booted) return;
    const decided = localStorage.getItem(firstRunKey(profileId)) !== null;
    if (shouldShowFirstRun({ decided, boardCount: boards.length, cloud: cloud?.state ?? null })) {
      setPhase("firstRun");
    } else {
      setPhase("ready");
    }
  }, [booted, profileId, boards.length, cloud]);

  function decideFirstRun() {
    try {
      localStorage.setItem(firstRunKey(profileId), "local");
    } catch {
      /* storage unavailable: the choice still applies for this session */
    }
  }

  function changeLanguage(next: Locale) {
    setLocale(next);
    void window.i18n.setOverride(next);
    setLocaleState(next);
  }

  async function signOut() {
    try {
      setCloud(await window.cloud.logout());
    } catch {
      /* stay as-is */
    }
  }

  if (!booted || phase === "boot") {
    return <Boot profileReady={profiles !== null} profileName={profileName} sessionsReady={loaded} onReady={onBootReady} />;
  }

  if (phase === "firstRun") {
    return (
      <FirstRun
        locale={locale}
        onLanguage={changeLanguage}
        onSignIn={() => setPhase("login")}
        onLocal={() => {
          decideFirstRun();
          setPhase("ready");
        }}
      />
    );
  }

  if (phase === "login") {
    return (
      <LoginScreen
        onClose={() => {
          void window.profiles.list().then(setProfiles).catch(() => {});
          setPhase("ready");
        }}
        onDone={() => {
          decideFirstRun();
          void window.profiles.list().then(setProfiles).catch(() => {});
          void window.cloud.status().then(setCloud).catch(() => {});
          setPhase("ready");
        }}
      />
    );
  }

  return (
    <>
      <Shell
        boards={boards}
        boardCounts={boardCounts}
        workspaceRoot={workspaceRoot}
        defaultCwd={defaultCwd}
        cloud={cloud}
        onChangeRoot={onChangeRoot}
        onNavigateRoot={onNavigateRoot}
        onOpenBoard={onOpenBoard}
        onCreateBoard={onCreateBoard}
        onUpdateBoard={onUpdateBoard}
        onDeleteBoard={onDeleteBoard}
        onStopBoard={onStopBoard}
        onOpenSettings={onOpenSettings}
        onSignIn={() => setPhase("login")}
        onSignOut={() => void signOut()}
      />
      {inviteToken ? (
        <InviteDialog
          token={inviteToken}
          onClose={() => setInviteToken(null)}
          onAccepted={() => {
            setInviteToken(null);
            void window.profiles.list().then(setProfiles).catch(() => {});
          }}
        />
      ) : null}
    </>
  );
}
