/**
 * Settings › Perfis — Configuracoes.dc.html #perfis / #perfis-editando / #perfis-erro.
 *
 * The profiles of this machine (each can be renamed here, through `profiles:rename`)
 * and, with an account, the account's profiles. Those can be renamed too, with the same field,
 * but the name lives on the server: the personal one always, a team's only for its owner/admin,
 * and never offline (the button is disabled and says why).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { t } from "../../shared/i18n";
import type { ProfileView, ProfilesState } from "../../preload/index";
import { useCloudPlan } from "./PlanHooks";
import { useAccountProfiles } from "./account-scope";
import type { AccountProfileView } from "./account-scope-decision";
import {
  ACCOUNT_RENAME_BLOCK_KEY,
  ACCOUNT_RENAME_FAILURE_KEY,
  decideAccountRename,
  type RoleReading,
} from "./settings-account-rename-decision";
import { useAccountTeamRoles } from "./settings-account-roles";
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

/** The edit row of a profile, the same for the machine's and the account's. */
function RenameEditRow({
  rowPart,
  profileId,
  kind,
  name,
  draft,
  error,
  busy,
  note,
  inputRef,
  onDraft,
  onSave,
  onCancel,
}: {
  rowPart: "profile-row" | "account-profile-row";
  profileId: string;
  kind: string;
  name: string;
  draft: string;
  error: string | null;
  busy: boolean;
  note: string;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  onDraft: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className={`${styles.row} ${styles.profileEditRow}`}
      data-part={rowPart}
      data-profile={kind}
      {...(rowPart === "profile-row" ? { "data-profile-id": profileId } : { "data-account-profile-id": profileId })}
      data-editing="true"
    >
      <span className={avatarClass(kind)} style={{ marginTop: 1 }}>
        {initial(name)}
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
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
            }}
          />
          <button type="button" className={styles.primary} data-part="rename-save" disabled={busy} onClick={onSave}>
            {t("settings.profiles.save")}
          </button>
          <button type="button" className={styles.btn} data-part="rename-cancel" onClick={onCancel}>
            {t("settings.profiles.cancel")}
          </button>
        </div>
        {error ? (
          <span className={`${styles.hint} ${styles.hintError}`} data-part="rename-error" role="alert">
            {error}
          </span>
        ) : null}
        <span className={styles.hint}>{note}</span>
      </div>
    </div>
  );
}

function PencilGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M12 3l3 3-8.5 8.5H3.5v-3z" />
    </svg>
  );
}

/** What is being edited: a profile of this machine or one of the account (their ids are not comparable). */
type Editing = { scope: "machine" | "account"; id: string };

export function ProfilesPage({ closeInterceptorRef }: { closeInterceptorRef?: MutableRefObject<(() => boolean) | null> }) {
  const { status } = useCloudPlan();
  const [state, setState] = useState<ProfilesState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
  const editingRef = useRef<Editing | null>(null);
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
  // The account answered (or is being asked): only a list that failed or came from the saved copy means "offline".
  const online = accountProfiles.status === "ok" || accountProfiles.status === "loading";
  const teamIds = accountProfiles.profiles.flatMap((p) => (p.kind === "team" && p.teamId !== null ? [p.teamId] : []));
  const roles = useAccountTeamRoles(teamIds, loggedIn && online);

  function startEdit(scope: Editing["scope"], id: string, name: string) {
    setEditing({ scope, id });
    setDraft(name);
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

  async function saveAccount(p: AccountProfileView) {
    const next = draft.trim();
    if (next === p.name) {
      cancel();
      return;
    }
    setBusy(true);
    try {
      const res = await window.profiles.renameAccountProfile(p.id, next);
      if (!res.ok) {
        setError(t(ACCOUNT_RENAME_FAILURE_KEY[res.reason], { max: String(PROFILE_NAME_MAX) }));
        return;
      }
      setEditing(null);
      setError(null);
      // The account list reloads on this event (see `useAccountProfiles`), here and in the profile menu.
      window.dispatchEvent(new Event(PROFILES_CHANGED_EVENT));
    } catch {
      setError(t(ACCOUNT_RENAME_FAILURE_KEY.failed));
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
          editing?.scope === "machine" && editing.id === p.id ? (
            <RenameEditRow
              key={p.id}
              rowPart="profile-row"
              profileId={p.id}
              kind={p.kind}
              name={p.name}
              draft={draft}
              error={error}
              busy={busy}
              note={t("settings.profiles.onlyName")}
              inputRef={inputRef}
              onDraft={(value) => {
                setDraft(value);
                setError(null);
              }}
              onSave={() => void save(p)}
              onCancel={cancel}
            />
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
                onClick={() => startEdit("machine", p.id, p.name)}
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
          {accountProfiles.profiles.map((p) => {
            if (editing?.scope === "account" && editing.id === p.id) {
              return (
                <RenameEditRow
                  key={p.id}
                  rowPart="account-profile-row"
                  profileId={p.id}
                  kind={p.kind}
                  name={p.name}
                  draft={draft}
                  error={error}
                  busy={busy}
                  note={t("settings.profiles.accountOnlyName")}
                  inputRef={inputRef}
                  onDraft={(value) => {
                    setDraft(value);
                    setError(null);
                  }}
                  onSave={() => void saveAccount(p)}
                  onCancel={cancel}
                />
              );
            }
            const role: RoleReading = p.teamId !== null ? (roles[p.teamId] ?? { state: "checking" }) : { state: "unavailable" };
            const gate = decideAccountRename({ profile: p, online, role });
            const why = gate.can ? null : t(ACCOUNT_RENAME_BLOCK_KEY[gate.reason]);
            return (
              <div key={p.id} className={styles.row} data-part="account-profile-row" data-account-profile-id={p.id}>
                <span className={avatarClass(p.kind)}>{initial(p.name)}</span>
                <div className={styles.lbl}>
                  <span data-part="account-profile-name">{p.name}</span>
                  <span className={styles.hint}>
                    {p.kind === "team" ? t("profiles.account.team") : t("profiles.account.personal")}
                    {why ? (
                      <>
                        {" · "}
                        <span data-part="rename-blocked" data-reason={gate.can ? undefined : gate.reason}>
                          {why}
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.btn}
                  data-part="rename-btn"
                  aria-label={t("settings.profiles.renameAria", { name: p.name })}
                  disabled={!gate.can}
                  title={why ?? undefined}
                  onClick={() => startEdit("account", p.id, p.name)}
                >
                  <PencilGlyph />
                  {t("settings.profiles.rename")}
                </button>
              </div>
            );
          })}
          <span className={styles.hint} data-part="account-name-note">
            {t("settings.profiles.accountNoteEditable")}
          </span>
        </section>
      ) : null}
    </>
  );
}
