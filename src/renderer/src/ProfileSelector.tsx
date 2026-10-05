import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type { ProfileHomeStatus, ProfileKind, ProfilesState, ProviderHomeMode } from "../../preload/index";
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
export function ProfileSelector({ onOpenSettings, loggedIn = false }: { onOpenSettings?: () => void; loggedIn?: boolean }) {
  const [state, setState] = useState<ProfilesState | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProfileKind>("team");
  const [homeMode, setHomeMode] = useState<ProviderHomeMode>("isolated");
  const [home, setHome] = useState<ProfileHomeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
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
        <span className={`${styles.avatar} ${active?.kind === "team" ? styles.avatarTeam : styles.avatarPersonal}`}>
          {active ? initials(active.name) : "?"}
        </span>
        <span className={styles.text}>
          <span className={styles.name}>{active ? active.name : t("profiles.unavailable")}</span>
          <span className={styles.sub}>{`${userName()} · ${loggedIn ? t("profiles.sub.synced") : t("profiles.sub.local")}`}</span>
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
                aria-checked={p.isActive}
                className={styles.row}
                disabled={busy || switching || p.isActive || !p.openable}
                onClick={() => void handleSwitch(p.id)}
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
                {p.isActive ? (
                  <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="var(--v2-accent-3)" strokeWidth="1.7" aria-hidden="true">
                    <path d="M3 7.2l2.6 2.6L11 4.4" />
                  </svg>
                ) : null}
              </button>
            ))
          )}

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
            <button type="button" className={styles.actionRow} onClick={() => onOpenSettings()}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <circle cx="8" cy="8" r="2.2" />
                <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6" />
              </svg>
              {t("profiles.manage")}
            </button>
          ) : null}
          {switching ? (
            <div className={styles.saving}>{t("profiles.switching")}</div>
          ) : (
            <div className={styles.hint}>{t("profiles.switchHint")}</div>
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
