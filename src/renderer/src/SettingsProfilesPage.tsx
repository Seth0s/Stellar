/**
 * Settings › Perfis — Configuracoes.dc.html #perfis / #perfis-editando / #perfis-erro.
 *
 * The profiles of this machine (each can be renamed here, through `profiles:rename`)
 * and, with an account, the account's profiles (read-only: their names come from the server).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { t } from "../../shared/i18n";
import type { ProfileView, ProfilesState } from "../../preload/index";
import { useCloudPlan } from "./PlanHooks";
import { useAccountProfiles } from "./account-scope";
import { PROFILES_CHANGED_EVENT } from "./settings-nav-decision";
import styles from "./SettingsModal.module.css";

/** Mirrors `MAX_PROFILE_NAME_LENGTH` in main/profiles-decision.ts (the renderer cannot import it:
 *  that module reaches node:path); a unit test keeps the two equal. */
export const PROFILE_NAME_MAX = 60;

function initial(name: string): string {
  const first = name.trim()[0];
  return first ? first.toUpperCase() : "?";
}

function avatarClass(kind: string): string {
  return `${styles.profileAvatar}${kind === "team" ? ` ${styles.profileAvatarTeam}` : ""}`;
}

/** Why a rename was refused, as the text the page shows under the field. */
function refusalText(reason: string): string {
  if (reason === "duplicate-name") return t("settings.profiles.duplicate");
  if (reason === "invalid-name") return t("settings.profiles.invalid", { max: String(PROFILE_NAME_MAX) });
  return t("profiles.error.save-failed");
}

function PencilGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3l3 3-8.5 8.5H3.5v-3z" />
    </svg>
  );
}

export function ProfilesPage({ closeInterceptorRef }: { closeInterceptorRef?: MutableRefObject<(() => boolean) | null> }) {
  const { status } = useCloudPlan();
  const [state, setState] = useState<ProfilesState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await window.profiles.list());
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(PROFILES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // The modal closes on Esc before any field sees it: while a name is being edited, the first
  // close request (Esc) only leaves the edit, like the Shortcuts page does for its capture.
  const editingRef = useRef<string | null>(null);
  editingRef.current = editing;
  useEffect(() => {
    if (!closeInterceptorRef) return;
    closeInterceptorRef.current = () => {
      if (editingRef.current === null) return false;
      setEditing(null);
      setError(null);
      return true;
    };
    return () => {
      closeInterceptorRef.current = null;
    };
  }, [closeInterceptorRef]);

  const loggedIn = status?.state === "logged-in";
  const accountProfiles = useAccountProfiles(loggedIn ? status : null, state?.activeProfileId ?? null);
  const identity = status?.state === "logged-in" ? (status.account.identities[0]?.login || status.account.displayName) : "";

  function startEdit(p: ProfileView) {
    setEditing(p.id);
    setDraft(p.name);
    setError(null);
  }

  function cancel() {
    setEditing(null);
    setError(null);
  }

  async function save(p: ProfileView) {
    const next = draft.trim();
    if (next === p.name) {
      cancel();
      return;
    }
    setBusy(true);
    try {
      const res = await window.profiles.rename(p.id, next);
      setState(res.state);
      if (!res.ok) {
        setError(refusalText(res.reason));
        return;
      }
      setEditing(null);
      setError(null);
      window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT));
    } catch {
      setError(refusalText("save-failed"));
    } finally {
      setBusy(false);
    }
  }

  const profiles = state?.profiles ?? [];

  return (
    <>
      <section className={styles.sec} data-part="profiles-machine">
        <h3 className={styles.sh}>{t("settings.profiles.machine")}</h3>
        {profiles.map((p) =>
          editing === p.id ? (
            <div
              key={p.id}
              className={`${styles.row} ${styles.profileEditRow}`}
              data-part="profile-row"
              data-profile={p.kind}
              data-profile-id={p.id}
              data-editing="true"
            >
              <span className={avatarClass(p.kind)} style={{ marginTop: 1 }}>
                {initial(p.name)}
              </span>
              <div className={`${styles.lbl} ${styles.profileEditStack}`}>
                <div className={styles.profileEditLine}>
                  <input
                    ref={inputRef}
                    className={`${styles.field} ${styles.profileInput}${error ? ` ${styles.profileInputError}` : ""}`}
                    data-part="rename-input"
                    aria-label={t("settings.profiles.nameAria")}
                    aria-invalid={error ? true : undefined}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void save(p);
                      }
                    }}
                  />
                  <button type="button" className={styles.primary} data-part="rename-save" disabled={busy} onClick={() => void save(p)}>
                    {t("settings.profiles.save")}
                  </button>
                  <button type="button" className={styles.btn} data-part="rename-cancel" onClick={cancel}>
                    {t("settings.profiles.cancel")}
                  </button>
                </div>
                {error ? (
                  <span className={`${styles.hint} ${styles.hintError}`} data-part="rename-error" role="alert">
                    {error}
                  </span>
                ) : null}
                <span className={styles.hint}>{t("settings.profiles.onlyName")}</span>
              </div>
            </div>
          ) : (
            <div key={p.id} className={styles.row} data-part="profile-row" data-profile={p.kind} data-profile-id={p.id}>
              <span className={avatarClass(p.kind)}>{initial(p.name)}</span>
              <div className={styles.lbl}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span data-part="profile-name">{p.name}</span>
                  {p.isActive ? <span className={styles.pillOk}>{t("settings.profiles.active")}</span> : null}
                </span>
                <span className={styles.hint}>
                  {p.kind === "team" ? t("profiles.kind.team") : t("profiles.kind.personal")} ·{" "}
                  {p.homeMode === "isolated" ? t("profiles.home.isolated") : t("profiles.home.system")}
                </span>
              </div>
              <button
                type="button"
                className={styles.btn}
                data-part="rename-btn"
                aria-label={t("settings.profiles.renameAria", { name: p.name })}
                onClick={() => startEdit(p)}
              >
                <PencilGlyph />
                {t("settings.profiles.rename")}
              </button>
            </div>
          ),
        )}
        <span className={styles.hint}>{t("settings.profiles.machineNote")}</span>
      </section>

      {loggedIn ? (
        <section className={styles.sec} data-part="profiles-account">
          <h3 className={styles.sh}>{t("settings.profiles.account", { identity })}</h3>
          {accountProfiles.profiles.map((p) => (
            <div key={p.id} className={styles.row} data-part="account-profile-row" data-account-profile-id={p.id}>
              <span className={avatarClass(p.kind)}>{initial(p.name)}</span>
              <div className={styles.lbl}>
                <span>{p.name}</span>
                <span className={styles.hint}>{p.kind === "team" ? t("profiles.account.team") : t("profiles.account.personal")}</span>
              </div>
            </div>
          ))}
          <span className={styles.hint} data-part="account-name-note">
            {t("settings.profiles.accountNote")}
          </span>
        </section>
      ) : null}
    </>
  );
}
