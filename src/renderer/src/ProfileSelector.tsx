import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import type { ProfileHomeStatus, ProfileKind, ProfilesState, ProviderHomeMode } from "../../preload/index";
import styles from "./ProfileSelector.module.css";

/** Motivos da casca (`profiles.ts` / `profiles-decision.ts`) → chave i18n. Um
 *  motivo desconhecido NÃO vira string crua na tela: cai no genérico. */
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

function kindLabel(kind: ProfileKind): string {
  return t(kind === "personal" ? "profiles.kind.personal" : "profiles.kind.team");
}

/**
 * Seletor de perfil na Home (BACKEND_V1.md §3/§7.1): mostra o perfil ATIVO e
 * permite criar, renomear e TROCAR. Trocar reabre o app no perfil escolhido —
 * o registro e `profiles/` vivem na raiz do userData (main), então a ação
 * passa por IPC e o processo sai em seguida.
 *
 * Ausência é dita, não inventada: registro ilegível → "não deu para ler"; um
 * perfil cujo diretório sumiu não oferece "Abrir" (mostra o que falta).
 */
export function ProfileSelector() {
  const [state, setState] = useState<ProfilesState | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"list" | "create">("list");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProfileKind>("team");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [home, setHome] = useState<ProfileHomeStatus | null>(null);
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

  async function changeHomeMode(mode2: ProviderHomeMode) {
    const activeId = state?.activeProfileId;
    if (!activeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.profiles.setHomeMode(activeId, mode2);
      setHome(res.home);
      if (res.ok) setState(res.state);
      else setError(reasonText(res.reason));
    } catch {
      setError(t("profiles.error.save-failed"));
    } finally {
      setBusy(false);
    }
  }

  const resetForm = useCallback(() => {
    setMode("list");
    setName("");
    setRenamingId(null);
    setRenameValue("");
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        resetForm();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        resetForm();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, resetForm]);

  const profiles = state?.profiles ?? [];
  const active = profiles.find((p) => p.isActive) ?? profiles.find((p) => p.isDefault) ?? null;

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await window.profiles.create({ name: name.trim(), kind });
      setState(res.state);
      if (!res.ok) {
        setError(reasonText(res.reason));
        return;
      }
      setMode("list");
      setName("");
    } catch {
      setError(t("profiles.error.save-failed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await window.profiles.rename(id, renameValue.trim());
      setState(res.state);
      if (!res.ok) {
        setError(reasonText(res.reason));
        return;
      }
      setRenamingId(null);
      setRenameValue("");
    } catch {
      setError(t("profiles.error.save-failed"));
    } finally {
      setBusy(false);
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
      // O app sai e relança no perfil alvo; mantém o aviso na tela até o fim.
      setSwitching(true);
    } catch {
      setBusy(false);
      setError(t("profiles.error.save-failed"));
    }
  }

  const triggerLabel = active ? active.name : t("profiles.unavailable");

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          resetForm();
        }}
        title={t("profiles.switchHint")}
      >
        <span className={styles.dot} aria-hidden="true" />
        {triggerLabel}
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label={t("profiles.title")}>
          {profiles.length === 0 ? (
            <div className={styles.missing}>{t("profiles.unavailable")}</div>
          ) : (
            <ul className={styles.list}>
              {profiles.map((p) => (
                <li key={p.id} className={`${styles.item}${p.isActive ? ` ${styles.itemActive}` : ""}`}>
                  {renamingId === p.id ? (
                    <>
                      <input
                        className={styles.input}
                        value={renameValue}
                        autoFocus
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRename(p.id);
                        }}
                      />
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={busy || renameValue.trim() === ""}
                        onClick={() => void handleRename(p.id)}
                      >
                        {t("common.save")}
                      </button>
                      <button
                        type="button"
                        className={styles.btn}
                        onClick={() => {
                          setRenamingId(null);
                          setError(null);
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={styles.name} title={kindLabel(p.kind)}>
                        {p.name}
                      </span>
                      {p.isActive && <span className={`${styles.badge} ${styles.badgeActive}`}>{t("profiles.active")}</span>}
                      {!p.isActive && p.isDefault && <span className={styles.badge}>{t("profiles.default")}</span>}
                      {!p.openable && <span className={styles.missing}>{t("profiles.missingDirectory")}</span>}
                      {!p.isActive && p.openable && (
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={busy || switching}
                          onClick={() => void handleSwitch(p.id)}
                        >
                          {t("profiles.switch")}
                        </button>
                      )}
                      {!p.isActive && (
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={busy || switching}
                          onClick={() => {
                            setRenamingId(p.id);
                            setRenameValue(p.name);
                            setError(null);
                          }}
                        >
                          {t("common.rename")}
                        </button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {mode === "list" ? (
            <div className={styles.row}>
              <button
                type="button"
                className={styles.btn}
                disabled={busy || switching || profiles.length === 0}
                onClick={() => {
                  setMode("create");
                  setName("");
                  setError(null);
                }}
              >
                {t("profiles.create")}
              </button>
            </div>
          ) : (
            <>
              <div className={styles.row}>
                <input
                  className={styles.input}
                  placeholder={t("profiles.name")}
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim() !== "") void handleCreate();
                  }}
                />
                <select className={styles.select} value={kind} onChange={(e) => setKind(e.target.value as ProfileKind)}>
                  <option value="team">{t("profiles.kind.team")}</option>
                  <option value="personal">{t("profiles.kind.personal")}</option>
                </select>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || name.trim() === ""}
                  onClick={() => void handleCreate()}
                >
                  {t("common.create")}
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => {
                    setMode("list");
                    setError(null);
                  }}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </>
          )}

          {home && home.homeMode !== null && (
            <div className={styles.homeSection}>
              <div className={styles.head}>
                <span>{t("profiles.home.label")}</span>
                <span className={styles.badge}>
                  {home.homeMode === "isolated" ? t("profiles.home.isolated") : t("profiles.home.system")}
                </span>
              </div>
              <div className={styles.row}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.wide}`}
                  disabled={busy}
                  onClick={() => void changeHomeMode(home.homeMode === "isolated" ? "system" : "isolated")}
                >
                  {home.homeMode === "isolated" ? t("profiles.home.useSystem") : t("profiles.home.useIsolated")}
                </button>
              </div>
              {home.homeMode === "isolated" && (
                <>
                  <ul className={styles.identities}>
                    {home.providers.map((p) => (
                      <li key={p.id} className={styles.identity}>
                        <span className={styles.badge}>{p.label}</span>
                        {p.supported ? t("profiles.home.supported") : `⚠ ${t("profiles.home.unsupported")}`}
                      </li>
                    ))}
                  </ul>
                  {home.providers.some((p) => !p.supported) && (
                    <div className={styles.warn}>{t("profiles.home.warnUnsupported")}</div>
                  )}
                </>
              )}
            </div>
          )}

          {error && <div className={styles.error}>{error}</div>}
          {switching ? (
            <div className={styles.saving}>{t("profiles.switching")}</div>
          ) : (
            <div className={styles.hint}>{t("profiles.switchHint")}</div>
          )}
        </div>
      )}
    </div>
  );
}
