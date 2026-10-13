/**
 * Account view hook — the renderer's single read of "local or account", which
 * account profile is in view, and which sessions belong to it (see
 * account-scope-decision.ts). Called once, by AppShell; everything below gets
 * the result as props.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CloudStatusInfo } from "../../preload/index";
import { hasCloudAccount } from "./account-mode-decision";
import { readOfflineAccount } from "./account-display-decision";
import { PROFILES_CHANGED_EVENT } from "./settings-nav-decision";
import {
  accountProfilesFrom,
  assignmentsFromRows,
  effectiveAccountProfile,
  effectiveScope,
  migrateLegacyAssignments,
  newBoardIds,
  partitionBoards,
  readProfilesCache,
  readStoredAccountProfile,
  readStoredScope,
  writeProfilesCache,
  writeStoredAccountProfile,
  writeStoredScope,
  type AccountProfileView,
  type AccountScope,
  type SessionAssignments,
} from "./account-scope-decision";

/** Fired after the session owners were written to the database outside of a component. */
const OWNERS_CHANGED = "ac:account-sessions-changed";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export type AccountProfilesState = {
  profiles: AccountProfileView[];
  /**
   * `error` = the list could not be read and none is saved; `stale` = no connection,
   * showing the list saved by the last successful read (`savedAtMs` says when).
   */
  status: "idle" | "loading" | "ok" | "error" | "stale";
  /** When `stale`: when the list was last refreshed. */
  savedAtMs: number | null;
  reload: () => void;
};

/**
 * The account's profiles (Pro, one per team), read from the account overview.
 * Every successful read is saved; with a saved session but no connection the
 * saved list stands in, marked stale.
 */
export function useAccountProfiles(cloud: CloudStatusInfo | null, profileId: string | null): AccountProfilesState {
  const loggedIn = hasCloudAccount(cloud);
  const offline = readOfflineAccount(cloud) !== null;
  const [profiles, setProfiles] = useState<AccountProfileView[]>([]);
  const [status, setStatus] = useState<AccountProfilesState["status"]>("idle");
  const [savedAtMs, setSavedAtMs] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!loggedIn) {
      const cached = offline ? readProfilesCache(browserStorage(), profileId) : null;
      setProfiles(cached?.profiles ?? []);
      setSavedAtMs(cached?.savedAtMs ?? null);
      setStatus(cached ? "stale" : "idle");
      return;
    }
    let alive = true;
    setStatus("loading");
    setSavedAtMs(null);
    // The read failed: the list saved by the last good read stands in, marked stale; with none, it is an error.
    const showSaved = () => {
      if (!alive) return;
      const cached = readProfilesCache(browserStorage(), profileId);
      setProfiles(cached?.profiles ?? []);
      setSavedAtMs(cached?.savedAtMs ?? null);
      setStatus(cached ? "stale" : "error");
    };
    void window.team
      .overview()
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          const list = accountProfilesFrom(res.view.profiles, res.view.teams);
          writeProfilesCache(browserStorage(), profileId, { profiles: list, savedAtMs: Date.now() });
          setProfiles(list);
          setStatus("ok");
        } else {
          showSaved();
        }
      })
      .catch(() => {
        if (alive) showSaved();
      });
    return () => {
      alive = false;
    };
  }, [loggedIn, offline, profileId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  // A profile was renamed (here or on the server): read the list again.
  useEffect(() => {
    window.addEventListener(PROFILES_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, reload);
  }, [reload]);
  return { profiles, status, savedAtMs, reload };
}

export type AccountView = {
  scope: AccountScope;
  setScope: (next: AccountScope) => void;
  /** The account profile in view (`null` while the list is not known). */
  accountProfile: AccountProfileView | null;
  /** Picks an account profile and moves to the account scope. */
  pickAccountProfile: (id: string) => void;
  /** Which account profile owns each session (read from the database). */
  assignments: SessionAssignments;
  /** Moves local sessions into the account profile in view. */
  importBoards: (ids: readonly string[]) => void;
  /** Call right before creating a session: the next new one joins the account profile in view. */
  expectNewBoard: (knownIds: ReadonlySet<string>) => void;
  /** Sessions of the view the user is looking at. */
  visibleBoards: <T extends { id: string }>(boards: readonly T[]) => T[];
  /** The sessions kept on this machine, whatever view is open: what an import can bring. */
  localBoards: <T extends { id: string }>(boards: readonly T[]) => T[];
};

/**
 * `boards` is only used to notice that the session list changed (a session was
 * created or deleted): the owners themselves are read from the database, so
 * they are right even when the app's own list has not caught up yet.
 */
export function useAccountView(
  cloud: CloudStatusInfo | null,
  profileId: string | null,
  profilesState: AccountProfilesState,
  boards: readonly { id: string }[],
): AccountView {
  // The account counts as present while a saved session is only waiting for the connection.
  const loggedIn = hasCloudAccount(cloud) || readOfflineAccount(cloud) !== null;
  const [storedScope, setStoredScope] = useState<AccountScope | null>(() => readStoredScope(browserStorage(), profileId));
  const [storedProfile, setStoredProfile] = useState<string | null>(() => readStoredAccountProfile(browserStorage(), profileId));
  const [assignments, setAssignments] = useState<SessionAssignments>({});

  // The scope and the profile in view are per local profile: reload them when it changes.
  useEffect(() => {
    setStoredScope(readStoredScope(browserStorage(), profileId));
    setStoredProfile(readStoredAccountProfile(browserStorage(), profileId));
  }, [profileId]);

  const refreshOwners = useCallback(async () => {
    try {
      setAssignments(assignmentsFromRows(await window.store.boards.list()));
    } catch {
      /* keep what is shown; the next change reads again */
    }
  }, []);

  // Owners come from the database: read on mount, whenever the session list
  // changes, and whenever a write made outside a component says it landed.
  const boardKey = boards.map((b) => b.id).join(",");
  useEffect(() => {
    void refreshOwners();
  }, [refreshOwners, boardKey]);
  useEffect(() => {
    window.addEventListener(OWNERS_CHANGED, refreshOwners as EventListener);
    return () => window.removeEventListener(OWNERS_CHANGED, refreshOwners as EventListener);
  }, [refreshOwners]);

  // The partition used to live in the renderer's storage: move it into the
  // database once and clear the old key (see migrateLegacyAssignments).
  useEffect(() => {
    let alive = true;
    void migrateLegacyAssignments(browserStorage(), profileId, (ids, owner) => window.store.boards.setAccountProfile(ids, owner)).then(({ moved }) => {
      if (alive && moved) void refreshOwners();
    });
    return () => {
      alive = false;
    };
  }, [profileId, refreshOwners]);

  const setScope = useCallback(
    (next: AccountScope) => {
      writeStoredScope(browserStorage(), profileId, next);
      setStoredScope(next);
    },
    [profileId],
  );

  const accountProfile = useMemo(
    () => effectiveAccountProfile(profilesState.profiles, storedProfile),
    [profilesState.profiles, storedProfile],
  );

  const pickAccountProfile = useCallback(
    (id: string) => {
      writeStoredAccountProfile(browserStorage(), profileId, id);
      setStoredProfile(id);
      writeStoredScope(browserStorage(), profileId, "account");
      setStoredScope("account");
    },
    [profileId],
  );

  const importBoards = useCallback(
    (ids: readonly string[]) => {
      if (!accountProfile || ids.length === 0) return;
      void window.store.boards.setAccountProfile([...ids], accountProfile.id).then(refreshOwners, () => undefined);
    },
    [accountProfile, refreshOwners],
  );

  // The session create goes through the app and answers nothing, and the app leaves
  // the Home for the new session right away (this component unmounts), so the new
  // session is found by reading the store itself, outside of React's lifecycle, and
  // its owner is written to the database: the Home reads it back when it returns.
  const expectNewBoard = useCallback(
    (knownIds: ReadonlySet<string>) => {
      if (!accountProfile) return;
      const owner = accountProfile.id;
      void (async () => {
        const end = Date.now() + 8000;
        while (Date.now() < end) {
          await new Promise((r) => setTimeout(r, 150));
          const rows = await window.store.boards.list().catch(() => null);
          if (!rows) continue;
          const fresh = newBoardIds(knownIds, rows);
          if (fresh.length === 0) continue;
          await window.store.boards.setAccountProfile(fresh, owner).catch(() => 0);
          window.dispatchEvent(new Event(OWNERS_CHANGED));
          return;
        }
      })();
    },
    [accountProfile],
  );

  const scope = effectiveScope(loggedIn, storedScope);
  const visibleBoards = useCallback(
    <T extends { id: string }>(all: readonly T[]) =>
      partitionBoards(all, assignments, scope === "account" ? { scope: "account", accountProfileId: accountProfile?.id ?? null } : { scope: "local" }),
    [assignments, scope, accountProfile],
  );
  const localBoards = useCallback(
    <T extends { id: string }>(all: readonly T[]) => partitionBoards(all, assignments, { scope: "local" }),
    [assignments],
  );

  return { scope, setScope, accountProfile, pickAccountProfile, assignments, importBoards, expectNewBoard, visibleBoards, localBoards };
}
