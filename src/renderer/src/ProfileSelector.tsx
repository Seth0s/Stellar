import { useCallback, useEffect, useRef, useState } from "react";
import { t, getLocale } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type { ProfileHomeStatus, ProfileKind, ProfilesState, ProviderHomeMode } from "../../preload/index";
import type { AccountProfileView, AccountScope } from "./account-scope-decision";
import { formatStaleStamp } from "./account-display-decision";
import type { AccountProfilesState } from "./account-scope";
import { OPEN_SETTINGS_EVENT, PROFILES_CHANGED_EVENT } from "./settings-nav-decision";
import styles from "./ProfileSelector.module.css";

const REASON_KEYS: Record<string, MessageKey> = {
  "invalid-name": "profiles.error.invalid-name",
  "duplicate-name": "profiles.error.duplicate-name",
  "too-many": "profiles.error.too-many",
  "unknown-profile": "profiles.error.unknown-profile",
  "missing-directory": "profiles.error.missing-directory",
  "no-registry": "profiles.error.no-registry",
  "generate-failed": "profiles.error.generate-failed",
};

function reasonText(reason: string): string {
  return t(REASON_KEYS[reason] ?? "profiles.error.save-failed");
}

function initials(text: string): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** The OS user name — the last path segment of the home directory. */
function userName(): string {
  const home = window.system.homeDir;
  return home.split("/").filter(Boolean).pop() ?? "";
}

/**
 * Profile menu (tela 8): the profile button at the top of the sidebar, the
 * switch menu, and the "new profile" dialog with kind and per-profile CLI
 * folders. Switching reopens the app on the chosen profile; the registry and
 * `profiles/` live at the userData root, in the main process.
 */
export function ProfileSelector({
  onOpenSettings,
  loggedIn = false,
  sessionOffline = false,
  offlineSinceMs = null,
  accountName = null,
  accountIdentity = "",
  scope = "local",
  onScopeChange,
  accountProfiles,
  accountProfile = null,
  onPickAccountProfile,
  onSignIn,
  onSignOut,
}: {
  onOpenSettings?: () => void;
  loggedIn?: boolean;
  /** A saved session exists but the API cannot be reached (the app keeps retrying). */
  sessionOffline?: boolean;
  /** With `sessionOffline` and a saved account: when that account's data was last refreshed. */
  offlineSinceMs?: number | null;
  /** Display name of the signed-in account (`null` without one). */
  accountName?: string | null;
  /** E-mail or GitHub login the account signed in with. */
  accountIdentity?: string;
  /** The scope the app is in; the same value the content reads. */
  scope?: AccountScope;
  onScopeChange?: (next: AccountScope) => void;
  /** The account's profiles (Pro, one per team) and the one in view. */
  accountProfiles?: AccountProfilesState;
  accountProfile?: AccountProfileView | null;
  onPickAccountProfile?: (id: string) => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
}) {
  const [state, setState] = useState<ProfilesState | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProfileKind>("team");
  const [homeMode, setHomeMode] = useState<ProviderHomeMode>("isolated");
  const [home, setHome] = useState<ProfileHomeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await window.profiles.list());
    } catch {
      setState(null);
    }
  }, []);

  const refreshHome = useCallback(async () => {
    try {
      setHome(await window.profiles.homeStatus());
    } catch {
      setHome(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshHome();
  }, [refresh, refreshHome]);

  // A rename made in Settings shows here right away.
  useEffect(() => {
    window.addEventListener(PROFILES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const profiles = state?.profiles ?? [];
  const active = profiles.find((p) => p.isActive) ?? profiles.find((p) => p.isDefault) ?? null;
  // The switcher shows the account profile in view in the account scope (the account's name while
  // its profiles are not known yet), else the active local one.
  // A saved account stays on screen while only the connection is missing.
  const accountOffline = !loggedIn && sessionOffline && accountName !== null;
  const accountKnown = loggedIn || accountOffline;
  const inAccount = accountKnown && scope === "account";
  const sinceLabel = offlineSinceMs !== null ? formatStaleStamp(offlineSinceMs, getLocale()) : "";
  const accountShownName = accountProfile?.name ?? accountName ?? "";
  const shownName = inAccount ? accountShownName : (active?.name ?? t("profiles.unavailable"));

  /** The manual "try again" of an offline saved session (the app also retries on its own). */
  async function retrySession() {
    setRetrying(true);
    try {
      await window.cloud.retry();
    } catch {
      /* the status push tells whether it worked */
    } finally {
      setRetrying(false);
    }
  }

  async function handleSwitch(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await window.profiles.switch(id);
      if (!res.ok) {
        setError(reasonText(res.reason));
        setBusy(false);
        return;
      }
      setSwitching(true);
    } catch {
      setBusy(false);
      setError(t("profiles.error.save-failed"));
    }
  }

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await window.profiles.create({ name: name.trim(), kind, homeMode });
      setState(res.state);
      if (!res.ok) {
        setError(reasonText(res.reason));
        return;
      }
      setCreating(false);
      setName("");
      setOpen(false);
    } catch {
      setError(t("profiles.error.save-failed"));
    } finally {
      setBusy(false);
    }
  }

  const separating = (home?.providers ?? []).filter((p) => p.supported);
  const systemWide = (home?.providers ?? []).filter((p) => !p.supported);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        data-role="profile-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t("profiles.switchHint")}
      >
        <span
          className={`${styles.avatar} ${(inAccount ? accountProfile?.kind === "team" : active?.kind === "team") ? styles.avatarTeam : styles.avatarPersonal}`}
        >
          {inAccount ? initials(accountShownName) : active ? initials(active.name) : "?"}
          {sessionOffline ? <span className={styles.warnDot} data-role="profile-offline-dot" /> : null}
        </span>
        <span className={styles.text}>
          <span className={styles.name} data-role="profile-name">
            {shownName}
          </span>
          <span
            className={`${styles.sub}${sessionOffline ? ` ${styles.subWarn}` : ""}`}
            data-role="profile-sub"
            data-scope={inAccount ? "account" : "local"}
            data-account-name={inAccount ? (accountName ?? "") : undefined}
            data-account-identity={inAccount ? accountIdentity : undefined}
          >
            {sessionOffline
              ? sinceLabel !== "" && inAccount
                ? t("profiles.sub.offlineSince", { when: sinceLabel })
                : t("profiles.sub.offline")
              : inAccount
                ? accountIdentity
                : `${userName()} · ${t("profiles.sub.local")}`}
          </span>
        </span>
        <span className={styles.chevron} aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d={open ? "M4 8.5l3-3 3 3" : "M4 5.5l3 3 3-3"} />
          </svg>
        </span>
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label={t("profiles.title")}>
          <div className={styles.menuHead}>{t("profiles.menuHead")}</div>
          {profiles.length === 0 ? (
            <div className={styles.hint}>{t("profiles.unavailable")}</div>
          ) : (
            profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.isActive && !inAccount}
                className={styles.row}
                data-role="profile-row"
                data-profile-id={p.id}
                // The open profile can be re-selected only to leave the account scope.
                disabled={busy || switching || (p.isActive && !inAccount) || !p.openable}
                onClick={() => {
                  if (p.isActive) {
                    onScopeChange?.("local");
                    setOpen(false);
                  } else {
                    void handleSwitch(p.id);
                  }
                }}
              >
                <span className={`${styles.rowAvatar} ${p.kind === "team" ? styles.avatarTeam : styles.avatarPersonal}`}>
                  {initials(p.name)}
                </span>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{p.name}</span>
                  <span className={styles.rowSub}>
                    {p.kind === "team" ? t("profiles.kind.team") : t("profiles.kind.personal")} ·{" "}
                    {p.homeMode === "isolated" ? t("profiles.home.isolated") : t("profiles.home.system")}
                    {!p.openable ? ` · ${t("profiles.missingDirectory")}` : ""}
                  </span>
                </span>
                {p.isActive && !inAccount ? (
                  <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--v2-accent-3)" strokeWidth="1.7" aria-hidden="true">
                    <path d="M3 7.2l2.6 2.6L11 4.4" />
                  </svg>
                ) : null}
              </button>
            ))
          )}

          {accountKnown ? (
            <>
              <div className={styles.menuHead} data-role="menu-account-head">
                {t("profiles.menuHead.account", { name: accountIdentity !== "" ? accountIdentity : (accountName ?? "") })}
              </div>
              {accountProfiles?.status === "error" ? (
                <div className={styles.error} data-role="account-profiles-error" role="alert">
                  {t("profiles.account.loadFailed")}{" "}
                  <button type="button" className={styles.retryLink} data-role="account-profiles-retry" onClick={() => accountProfiles.reload()}>
                    {t("account.retry")}
                  </button>
                </div>
              ) : null}
              {(accountProfiles?.profiles ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={inAccount && accountProfile?.id === p.id}
                  className={styles.row}
                  data-role="profile-row-account"
                  data-account-profile-id={p.id}
                  data-account-kind={p.kind}
                  data-account-name={accountName ?? ""}
                  data-account-identity={accountIdentity}
                  disabled={busy || switching || (inAccount && accountProfile?.id === p.id)}
                  onClick={() => {
                    onPickAccountProfile?.(p.id);
                    setOpen(false);
                  }}
                >
                  <span className={`${styles.rowAvatar} ${p.kind === "team" ? styles.avatarTeam : styles.avatarPersonal}`}>{initials(p.name)}</span>
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{p.name}</span>
                    <span className={styles.rowSub}>
                      {p.kind === "team" ? t("profiles.account.team") : t("profiles.account.personal")}
                    </span>
                  </span>
                  {inAccount && accountProfile?.id === p.id ? (
                    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--v2-accent-3)" strokeWidth="1.7" aria-hidden="true">
                      <path d="M3 7.2l2.6 2.6L11 4.4" />
                    </svg>
                  ) : null}
                </button>
              ))}
              {accountProfiles?.status === "ok" && accountProfiles.profiles.length === 0 ? (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={inAccount}
                  className={styles.row}
                  data-role="profile-row-account"
                  data-account-name={accountName ?? ""}
                  data-account-identity={accountIdentity}
                  disabled={inAccount}
                  onClick={() => {
                    onScopeChange?.("account");
                    setOpen(false);
                  }}
                >
                  <span className={`${styles.rowAvatar} ${styles.avatarPersonal}`}>{initials(accountName ?? "")}</span>
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>{accountName}</span>
                    <span className={styles.rowSub}>{t("profiles.account.personal")}</span>
                  </span>
                </button>
              ) : null}
            </>
          ) : null}

          {!loggedIn && sessionOffline ? (
            <>
              {accountOffline ? null : <div className={styles.menuHead}>{t("profiles.menuHead.accountPlain")}</div>}
              <div className={styles.offlineBox} data-role="account-offline" role="status">
                <span className={styles.offlineTitle}>{t("account.offline.title")}</span>
                <span className={styles.offlineText}>{t("account.offline.desc")}</span>
                {sinceLabel !== "" ? (
                  <span className={styles.offlineText} data-role="account-stale-stamp">
                    {t("account.offline.stale", { when: sinceLabel })}
                  </span>
                ) : null}
                <span className={styles.offlineActions}>
                  <button type="button" className={styles.retryBtn} data-role="account-retry" disabled={retrying} onClick={() => void retrySession()}>
                    {t("account.retry")}
                  </button>
                  <span className={styles.offlineAuto}>{t("account.offline.auto")}</span>
                </span>
              </div>
            </>
          ) : null}

          {!loggedIn && !sessionOffline ? (
            <>
              <div className={styles.menuHead}>{t("profiles.menuHead.accountPlain")}</div>
              <button
                type="button"
                className={`${styles.row} ${styles.signInRow}`}
                data-role="sign-in"
                onClick={() => {
                  setOpen(false);
                  onSignIn?.();
                }}
              >
                <span className={`${styles.rowAvatar} ${styles.avatarPersonal}`}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <circle cx="8" cy="5.5" r="2.6" />
                    <path d="M3 13.5c1.1-2.4 2.9-3.6 5-3.6s3.9 1.2 5 3.6" />
                  </svg>
                </span>
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{t("shell.signIn.action")}</span>
                  <span className={styles.rowSub}>{t("profiles.signIn.sub")}</span>
                </span>
              </button>
            </>
          ) : null}

          <div className={styles.sep} />
          <button
            type="button"
            className={styles.actionRow}
            onClick={() => {
              setCreating(true);
              setOpen(false);
              void refreshHome();
            }}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M7 2.5v9M2.5 7h9" />
            </svg>
            {t("profiles.create")}
          </button>
          {onOpenSettings ? (
            <button
              type="button"
              className={styles.actionRow}
              data-role="manage-accounts"
              onClick={() => {
                setOpen(false);
                // Settings opens on its Perfis page (rename the machine's profiles, see the account's).
                window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { page: "profiles" } }));
              }}
            >
              {/* A person with a small gear: managing profiles and accounts, not a generic setting. */}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                <circle cx="6.5" cy="5" r="2.5" />
                <path d="M1.8 13.5c.4-2.6 2.3-4.2 4.7-4.2 1 0 1.9.3 2.6.8" />
                <circle cx="12" cy="12" r="1.25" />
                <path d="M12 9.3v.8M12 13.9v.8M9.3 12h.8M13.9 12h.8M10.1 10.1l.55.55M13.35 13.35l.55.55M10.1 13.9l.55-.55M13.35 10.65l.55-.55" />
              </svg>
              {t("profiles.manageAccounts")}
            </button>
          ) : null}
          {accountKnown ? (
            <button
              type="button"
              className={`${styles.actionRow} ${styles.signOutRow}`}
              data-role="sign-out"
              onClick={() => {
                setOpen(false);
                onSignOut?.();
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6.5" />
              </svg>
              {t("profiles.signOut")}
            </button>
          ) : null}
          {switching ? (
            <div className={styles.saving}>{t("profiles.switching")}</div>
          ) : (
            <div className={styles.hint}>
              {accountKnown ? t("profiles.switchHint.account") : sessionOffline ? t("profiles.switchHint") : t("profiles.hint.noAccount")}
            </div>
          )}
          {error ? <div className={styles.error}>{error}</div> : null}
        </div>
      )}

      {creating && (
        <>
          <div className={styles.scrim} onClick={() => setCreating(false)} />
          <div role="dialog" aria-label={t("profiles.create")} className={styles.dialog}>
            <div className={styles.dialogHead}>
              <h2 className={styles.dialogTitle}>{t("profiles.create")}</h2>
              <p className={styles.dialogSub}>{t("profiles.dialog.sub")}</p>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="pf-name">
                {t("profiles.name")}
              </label>
              <input
                id="pf-name"
                className={styles.input}
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() !== "") void handleCreate();
                }}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t("profiles.dialog.kind")}</span>
              <div className={styles.optGrid}>
                <button type="button" className={`${styles.opt}${kind === "personal" ? ` ${styles.optOn}` : ""}`} onClick={() => setKind("personal")}>
                  <span className={styles.optText}>
                    <span className={styles.optTitle}>{t("profiles.kind.personal")}</span>
                    <span className={styles.optSub}>{t("profiles.dialog.personalSub")}</span>
                  </span>
                </button>
                <button type="button" className={`${styles.opt}${kind === "team" ? ` ${styles.optOn}` : ""}`} onClick={() => setKind("team")}>
                  <span className={styles.optText}>
                    <span className={styles.optTitle}>{t("profiles.dialog.team")}</span>
                    <span className={styles.optSub}>{t("profiles.dialog.teamSub")}</span>
                  </span>
                </button>
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>{t("profiles.dialog.folders")}</span>
              <div className={styles.optGrid}>
                <button
                  type="button"
                  className={`${styles.opt}${homeMode === "isolated" ? ` ${styles.optOn}` : ""}`}
                  onClick={() => setHomeMode("isolated")}
                >
                  <span className={styles.optText}>
                    <span className={styles.optTitle}>
                      {t("profiles.dialog.isolated")} <span className={styles.recommended}>{t("profiles.dialog.recommended")}</span>
                    </span>
                    <span className={styles.optSub}>{t("profiles.dialog.isolatedSub")}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={`${styles.opt}${homeMode === "system" ? ` ${styles.optOn}` : ""}`}
                  onClick={() => setHomeMode("system")}
                >
                  <span className={styles.optText}>
                    <span className={styles.optTitle}>{t("profiles.dialog.system")}</span>
                    <span className={styles.optSub}>{t("profiles.dialog.systemSub")}</span>
                  </span>
                </button>
              </div>
              <div className={styles.chips}>
                {separating.map((p) => (
                  <span key={p.id} className={styles.chip}>
                    {p.label}
                  </span>
                ))}
                {systemWide.length > 0 ? (
                  <span className={`${styles.chip} ${styles.chipWarn}`}>{t("profiles.dialog.systemWide", { tools: systemWide.map((p) => p.label).join(", ") })}</span>
                ) : null}
              </div>
            </div>

            {error ? <div className={styles.error}>{error}</div> : null}

            <div className={styles.dialogActions}>
              <button type="button" className={styles.ghostBtn} onClick={() => setCreating(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className={styles.primaryBtn} disabled={busy || name.trim() === ""} onClick={() => void handleCreate()}>
                {t("profiles.dialog.createOpen")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
