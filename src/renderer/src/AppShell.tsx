import { useCallback, useEffect, useState } from "react";
import { setLocale, getLocale, type Locale } from "../../shared/i18n";
import type { BoardRow, BoardCounts, CloudStatusInfo, ProfilesState } from "../../preload/index";
import type { SessionTemplate } from "./useBoardStore";
import { Boot } from "./Boot";
import { FirstRun } from "./FirstRun";
import { LoginScreen } from "./LoginScreen";
import { InviteDialog, type InvitePreview } from "./InviteDialog";
import { Shell } from "./Shell";
import { useAccountScope } from "./account-scope";
import { shouldShowFirstRun } from "./home-decisions";
import { writeTeamBoardFocus } from "./board-quick-task-decisions";
import { maskIdentity, requestTeamSub } from "./team-admin-decisions";

function firstRunKey(profileId: string | null): string {
  return `ac.firstRun.${profileId ?? "default"}`;
}

type Phase = "boot" | "firstRun" | "login" | "ready";

type LoginV2Fixture = Awaited<ReturnType<typeof window.system.getLoginV2Fixture>>;

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
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [locale, setLocaleState] = useState<Locale>(getLocale());
  const [fixture, setFixture] = useState<LoginV2Fixture>(null);
  const [fixtureReady, setFixtureReady] = useState(false);
  const [homeSynced, setHomeSynced] = useState(false);
  // Bumped to remount the shell once an accepted invite should land on the team.
  const [shellKey, setShellKey] = useState(0);

  useEffect(() => {
    void window.system
      .getLoginV2Fixture()
      .then((f) => setFixture(f))
      .catch(() => setFixture(null))
      .finally(() => setFixtureReady(true));
    void window.profiles.list().then(setProfiles).catch(() => setProfiles(null));
    void window.cloud.status().then(setCloud).catch(() => {});
    const off = window.cloud.onStatusChanged(setCloud);
    void window.workhome
      .status()
      .then((s) => setHomeSynced(s.lastSyncAt !== null || s.lastRevision !== null))
      .catch(() => {});
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

  useEffect(() => {
    if (!fixture?.invite) return;
    setInviteToken(fixture.invite.token);
    setInvitePreview({
      teamName: fixture.invite.teamName,
      invitedByName: fixture.invite.inviterName,
      role: fixture.invite.role,
      targetMasked: maskIdentity(fixture.invite.email),
      expiresAt: new Date(Date.now() + fixture.invite.expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
    });
  }, [fixture]);

  const profileId = profiles?.activeProfileId ?? null;
  const { scope, setScope } = useAccountScope(cloud, profileId);
  const profileName = profiles?.profiles.find((p) => p.isActive)?.name ?? null;
  const sessionCount =
    typeof fixture?.boot?.sessionCount === "number" ? fixture.boot.sessionCount : boards.length;
  const bootHomeSynced = fixture?.boot?.homeSynced ?? homeSynced;
  const bootHold = !fixtureReady || fixture?.boot?.hold === true;

  const onBootReady = useCallback(() => setBooted(true), []);

  useEffect(() => {
    if (!booted) return;
    if (fixture?.login) {
      setPhase("login");
      return;
    }
    // Stay on the login screen until the user closes or finishes — a cloud
    // status push (pending → logged-out with lastError) must not bounce them
    // back to the shell mid-flow.
    if (phase === "login") return;
    // An invite is waiting: the guest lands on it, not on the first-run choice
    // (the invite dialog signs them in itself).
    if (inviteToken) {
      setPhase("ready");
      return;
    }
    if (fixture?.invite && !fixture.login) {
      setPhase("ready");
      return;
    }
    const decided = localStorage.getItem(firstRunKey(profileId)) !== null;
    if (shouldShowFirstRun({ decided, boardCount: boards.length, cloud: cloud?.state ?? null })) {
      setPhase("firstRun");
    } else {
      setPhase("ready");
    }
  }, [booted, profileId, boards.length, cloud, fixture, phase, inviteToken]);

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
    return (
      <Boot
        profileReady={profiles !== null}
        profileName={profileName}
        sessionsReady={loaded}
        sessionCount={sessionCount}
        homeSynced={bootHomeSynced}
        hold={bootHold}
        onReady={onBootReady}
      />
    );
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
        initialStep={fixture?.login?.step}
        initialMachineName={fixture?.login?.machineName}
        initialExpiresSec={fixture?.login?.expiresSec}
        fixtureDisplayName={fixture?.login?.displayName}
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
        key={shellKey}
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
        scope={scope}
        onScopeChange={setScope}
      />
      {inviteToken ? (
        <InviteDialog
          token={inviteToken}
          preview={invitePreview}
          onClose={() => {
            setInviteToken(null);
            setInvitePreview(null);
          }}
          onAccepted={() => {
            // The dialog stays up on its "joined" screen; only the profiles refresh.
            void window.profiles.list().then(setProfiles).catch(() => {});
            void window.cloud.status().then(setCloud).catch(() => {});
          }}
          onOpenTeam={(teamId) => {
            writeTeamBoardFocus({ teamId, unassigned: false });
            requestTeamSub("board");
            setShellKey((k) => k + 1);
          }}
        />
      ) : null}
    </>
  );
}
