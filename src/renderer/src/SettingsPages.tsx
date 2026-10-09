/**
 * Settings V7 page bodies — layout from SPEC-Configuracoes-V7.md.
 */
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { t, SUPPORTED_LOCALES, type Locale } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import { StellarMark } from "./StellarMark";
import { ProvidersPage } from "./ProvidersPage";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SecretsSettingsModal } from "./SecretsSettingsModal";
import { RemotePairingModal } from "./RemotePairingModal";
import {
  diffPreset,
  matchPreset,
  presetSettingsFromBoard,
  type BoardPreset,
  type BoardPresetSettings,
} from "../../main/board-preset-decision";
import { DEFAULT_CONCURRENCY_CAP } from "./task-board-model";
import type { ShortcutCombo, ShortcutOverrides } from "./shortcut-registry";
import { useCloudPlan, usePlansUrl } from "./PlanHooks";
import {
  applyReduceMotionPref,
  readReduceMotionPref,
  readTerminalFontSize,
  writeReduceMotionPref,
  writeTerminalFontSize,
  type ReduceMotionPref,
} from "./settings-appearance-prefs";
import { DEFAULT_MAX_BACKGROUND_SESSIONS } from "../../main/session-background";
import { DEFAULT_SCROLLBACK_MAX_BYTES } from "../../main/session-scrollback";
import { UNFOCUSED_FRAME_RATE } from "../../main/browser-frame-decision";
import styles from "./SettingsModal.module.css";

export type SettingsBoard = {
  id: string;
  name: string;
  autonomous: boolean;
  concurrency_cap: number | null;
  orchestrator_card_id?: string | null;
  default_review?: string | null;
  default_report_schema_json?: string | null;
  default_allow_commit?: number | null;
};

function Switch({
  on,
  label,
  onToggle,
}: {
  on: boolean;
  label: string;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={on ? styles.swOn : styles.sw}
      aria-pressed={on}
      aria-label={label}
      onClick={() => onToggle(!on)}
    >
      <span className={styles.swKnob} />
    </button>
  );
}

function ageLabel(at: number | null): string {
  if (at == null) return t("settings.account.neverSynced");
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return t("settings.account.lastSync", { when: "agora" });
  if (mins < 60) return t("settings.account.lastSync", { when: `há ${mins} min` });
  const hours = Math.round(mins / 60);
  return t("settings.account.lastSync", { when: `há ${hours} h` });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

export function AccountPage() {
  const { status, plan, loggedIn } = useCloudPlan();
  const plansUrl = usePlansUrl();
  const [wh, setWh] = useState<Awaited<ReturnType<typeof window.workhome.status>> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.workhome.status().then(setWh).catch(() => setWh(null));
  }, [loggedIn]);

  if (!loggedIn || status?.state !== "logged-in") {
    return (
      <section className={styles.sec}>
        <div className={styles.row}>
          <div className={styles.avatar}>?</div>
          <div className={styles.lbl}>
            <span>{t("settings.account.signedOut")}</span>
            <span className={styles.hint}>{t("settings.account.signedOutHint")}</span>
          </div>
          <button type="button" className={styles.btn} onClick={() => void window.cloud.login("github")}>
            {t("settings.account.signIn")}
          </button>
        </div>
      </section>
    );
  }

  const account = status.account;
  const syncRight = plan?.rights.sync;
  const planName = syncRight?.plan || plan?.accountPlan || "—";
  const planActive = syncRight?.granted === true;
  const origin = syncRight?.source;

  return (
    <>
      <section className={styles.sec}>
        <div className={styles.row}>
          <div className={styles.avatar}>{initials(account.displayName)}</div>
          <div className={styles.lbl}>
            <span>{account.displayName}</span>
            <span className={styles.hint}>
              {account.identities.map((i) => i.login || i.kind).filter(Boolean).join(" · ") || "—"}
            </span>
          </div>
          <button type="button" className={styles.btn} onClick={() => void window.cloud.logout()}>
            {t("settings.account.signOut")}
          </button>
        </div>
      </section>
      <section className={styles.sec}>
        <h3 className={styles.sh}>{t("settings.account.plan")}</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {planName}
              {planActive && <span className={styles.pillOk}>{t("settings.account.planActive")}</span>}
              {!planActive && <span className={styles.pillInfo}>{t("settings.account.planNone")}</span>}
            </span>
            <span className={styles.hint}>
              {plan?.accountExpiresAt
                ? `renova em ${new Date(plan.accountExpiresAt).toLocaleDateString()}`
                : t("settings.account.workHomeHint")}
            </span>
          </div>
          <a className={styles.btn} href={plansUrl} target="_blank" rel="noreferrer">
            {t("settings.account.viewPlans")}
          </a>
        </div>
        {origin && (
          <div className={styles.row}>
            <div className={styles.lbl}>
              <span>{origin === "team" ? "Time" : account.displayName}</span>
              <span className={styles.hint}>{origin === "team" ? "vaga do time" : "plano da conta"}</span>
            </div>
            <span className={styles.pillInfo}>
              {origin === "team" ? t("settings.account.originTeam") : t("settings.account.originAccount")}
            </span>
          </div>
        )}
      </section>
      <section className={styles.sec}>
        <h3 className={styles.sh}>{t("settings.account.workHome")}</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>
              {wh?.profileId ? `Perfil: ${wh.profileId.slice(0, 8)}` : t("settings.account.workHome")}
            </span>
            <span className={styles.hint}>
              {t("settings.account.workHomeHint")} · {ageLabel(wh?.lastSyncAt ?? null)}
            </span>
          </div>
          <button
            type="button"
            className={styles.btn}
            disabled={busy || !wh?.loggedIn}
            onClick={() => {
              setBusy(true);
              void window.workhome
                .syncNow()
                .then(() => window.workhome.status())
                .then(setWh)
                .finally(() => setBusy(false));
            }}
          >
            {t("settings.account.syncNow")}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("stellar:open-workhome"));
            }}
          >
            {t("settings.account.openHome")}
          </button>
        </div>
      </section>
    </>
  );
}

export function AppearancePage({
  locale,
  onLocaleOverrideChange,
}: {
  locale: Locale;
  onLocaleOverrideChange: (next: Locale | null) => void;
}) {
  const [override, setOverride] = useState<Locale | null>(null);
  const [systemLocale, setSystemLocale] = useState("");
  const [fontPx, setFontPx] = useState<13 | 14 | 15>(() => readTerminalFontSize());
  const [motion, setMotion] = useState<ReduceMotionPref>(() => readReduceMotionPref());

  useEffect(() => {
    void window.i18n.get().then((info) => {
      setOverride(info.override);
      setSystemLocale(info.systemLocale);
    });
    applyReduceMotionPref(readReduceMotionPref());
  }, [locale]);

  const LOCALE_LABEL: Record<Locale, string> = {
    "pt-BR": t("settings.locale.ptBR"),
    en: t("settings.locale.en"),
  };

  return (
    <section className={styles.sec}>
      <div className={styles.row}>
        <div className={styles.lbl}>
          <span>{t("settings.appearance.locale")}</span>
          <span className={styles.hint}>{t("settings.appearance.localeHint")}</span>
        </div>
        <select
          className={styles.field}
          value={override ?? "system"}
          aria-label={t("settings.appearance.locale")}
          onChange={(e) => {
            const next = e.target.value === "system" ? null : (e.target.value as Locale);
            setOverride(next);
            onLocaleOverrideChange(next);
          }}
        >
          <option value="system">{t("shortcuts.locale.system", { locale: systemLocale || locale })}</option>
          {SUPPORTED_LOCALES.map((tag) => (
            <option key={tag} value={tag}>
              {LOCALE_LABEL[tag]}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.row}>
        <div className={styles.lbl}>
          <span>{t("settings.appearance.terminalFont")}</span>
          <span className={styles.hint}>{t("settings.appearance.terminalFontHint")}</span>
        </div>
        <select
          className={styles.field}
          value={fontPx}
          aria-label={t("settings.appearance.terminalFont")}
          onChange={(e) => {
            const next = Number(e.target.value) as 13 | 14 | 15;
            setFontPx(next);
            writeTerminalFontSize(next);
          }}
        >
          <option value={13}>13 px</option>
          <option value={14}>14 px</option>
          <option value={15}>15 px</option>
        </select>
      </div>
      <div className={styles.row}>
        <div className={styles.lbl}>
          <span>{t("settings.appearance.reduceMotion")}</span>
          <span className={styles.hint}>{t("settings.appearance.reduceMotionHint")}</span>
        </div>
        <select
          className={styles.field}
          value={motion}
          aria-label={t("settings.appearance.reduceMotion")}
          onChange={(e) => {
            const next = e.target.value as ReduceMotionPref;
            setMotion(next);
            writeReduceMotionPref(next);
          }}
        >
          <option value="system">{t("settings.appearance.reduceMotionSystem")}</option>
          <option value="on">{t("settings.appearance.reduceMotionOn")}</option>
          <option value="off">{t("settings.appearance.reduceMotionOff")}</option>
        </select>
      </div>
    </section>
  );
}

export function PerformancePage() {
  const [bg, setBg] = useState<{ count: number; max: number } | null>(null);
  const scrollMb = Math.round((DEFAULT_SCROLLBACK_MAX_BYTES / (1024 * 1024)) * 10) / 10;

  useEffect(() => {
    void window.store.boardBackgroundStatus().then((s) => {
      setBg({ count: s.backgroundCount, max: s.maxBackgroundSessions });
    });
  }, []);

  return (
    <>
      <section className={styles.sec}>
        <h3 className={styles.sh}>{t("settings.perf.sectionSave")}</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.perf.background")}</span>
            <span className={styles.hint}>
              {t("settings.perf.backgroundHint", { n: String(DEFAULT_MAX_BACKGROUND_SESSIONS) })}
            </span>
          </div>
          <Switch on label={t("settings.perf.background")} onToggle={() => {}} />
        </div>
        <p className={styles.hint}>{t("settings.perf.readOnly")}</p>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.perf.browserIdle")}</span>
            <span className={styles.hint}>{t("settings.perf.browserIdleHint")}</span>
          </div>
          <select className={styles.field} disabled value={String(UNFOCUSED_FRAME_RATE)} aria-label={t("settings.perf.browserIdle")}>
            <option value="4">4 fps</option>
            <option value="8">8 fps</option>
            <option value="0">pausar</option>
          </select>
        </div>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.perf.scrollback")}</span>
            <span className={styles.hint}>{t("settings.perf.scrollbackHint")}</span>
          </div>
          <select className={styles.field} disabled value={String(scrollMb)} aria-label={t("settings.perf.scrollback")}>
            <option value="2">2 MB</option>
            <option value="5">5 MB</option>
            <option value="0.5">512 KB</option>
          </select>
        </div>
      </section>
      <section className={styles.sec}>
        <h3 className={styles.sh}>{t("settings.perf.now")}</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>Stellar</span>
            <span className={styles.hint}>
              {bg
                ? t("settings.perf.nowValue", { count: String(bg.count), max: String(bg.max) })
                : t("settings.perf.nowHint")}
            </span>
          </div>
          <button type="button" className={styles.btn} disabled>
            {t("settings.perf.details")}
          </button>
        </div>
      </section>
    </>
  );
}

export function AboutPage() {
  const [build, setBuild] = useState<{ version: string; parts: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  useEffect(() => {
    void window.system.getBuildIdentity().then((id) => {
      setBuild({ version: id.version, parts: [id.label, `bus protocol ${id.busProtocol}`] });
    });
  }, []);

  const versionText = build
    ? build.version === "unknown"
      ? t("settings.about.versionUnknown")
      : `Stellar ${build.version}`
    : t("settings.general.buildIdentityLoading");

  return (
    <section className={styles.sec}>
      <div className={styles.row}>
        <StellarMark size={44} />
        <div className={styles.lbl}>
          <span>{versionText}</span>
          <span className={`${styles.hint} ${styles.mono}`}>
            {build ? build.parts.join(" · ") : t("settings.general.buildIdentityLoading")}
          </span>
        </div>
        <button
          type="button"
          className={styles.primary}
          disabled={checking}
          onClick={() => {
            setChecking(true);
            setCheckMsg(null);
            void window.updater
              .check()
              .then((r) => {
                setCheckMsg(r.error || r.unavailable || (r.checked ? "ok" : "dev"));
              })
              .finally(() => setChecking(false));
          }}
        >
          {checking ? t("settings.about.checking") : t("settings.about.checkUpdate")}
        </button>
      </div>
      {checkMsg && (
        <div className={styles.row}>
          <span className={styles.hint}>{checkMsg}</span>
        </div>
      )}
      <div className={styles.row}>
        <div className={styles.lbl}>
          <span>{t("settings.about.relay")}</span>
          <span className={styles.hint}>{t("settings.about.relayHint")}</span>
        </div>
        <span className={styles.pillOk}>{t("settings.about.relayOn")}</span>
      </div>
      <div className={styles.linksRow}>
        <a className={styles.link} href="https://github.com/Seth0s/Stellar/releases" target="_blank" rel="noreferrer">
          Notas da versão
        </a>
        <a className={styles.link} href="https://stellar.idyplatform.com" target="_blank" rel="noreferrer">
          Termos
        </a>
        <a className={styles.link} href="https://stellar.idyplatform.com" target="_blank" rel="noreferrer">
          Privacidade
        </a>
        <span className={styles.hint}>{t("settings.about.openData")}</span>
      </div>
    </section>
  );
}

export function DevicesPage() {
  return (
    <>
      <section className={styles.sec} data-settings-devices-machines="">
        <h3 className={styles.sh}>Esta máquina</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{typeof window !== "undefined" ? "esta" : "—"}</span>
            <span className={styles.hint}>{t("settings.devices.mobileHint")}</span>
          </div>
          <span className={styles.pillOk}>esta</span>
        </div>
        <RemotePairingModal />
      </section>
      <section className={styles.sec}>
        <h3 className={styles.sh}>{t("settings.devices.mobile")}</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.devices.mobilePair")}</span>
            <span className={styles.hint}>{t("settings.devices.mobileHint")}</span>
          </div>
          <span className={styles.pillInfo}>{t("settings.devices.comingSoon")}</span>
        </div>
      </section>
    </>
  );
}

export function ProvidersSettingsPage() {
  return <ProvidersPage layout="v7" />;
}

export function KeysPage() {
  return (
    <section className={styles.sec}>
      <h3 className={styles.sh}>{t("settings.page.keys")}</h3>
      <span className={styles.hint}>
        Guardadas no chaveiro do sistema, nunca em arquivo. Usadas pelos cards de chat e pelas ações de IA.
      </span>
      <SecretsSettingsModal />
    </section>
  );
}

export function ShortcutsPage(props: {
  shortcutOverrides: ShortcutOverrides;
  onRebind: (id: string, combo: ShortcutCombo) => void;
  onRestoreDefault: (id: string) => void;
  onRestoreAll: () => void;
  closeInterceptorRef: React.MutableRefObject<(() => boolean) | null>;
}) {
  return (
    <section className={styles.sec}>
      <div className={styles.row}>
        <div className={styles.lbl}>
          <span>Todos os atalhos, por lugar</span>
          <span className={styles.hint}>
            a mesma tela do <span className={styles.kbd}>?</span>, com edição
          </span>
        </div>
      </div>
      <div className={styles.row}>
        <span className={styles.conflict}>
          Ao trocar, a tecla é recusada se já estiver em uso no mesmo lugar, e o conflito aparece aqui.
        </span>
      </div>
      <ShortcutsOverlay
        shortcutOverrides={props.shortcutOverrides}
        onRebind={props.onRebind}
        onRestoreDefault={props.onRestoreDefault}
        onRestoreAll={props.onRestoreAll}
        closeInterceptorRef={props.closeInterceptorRef}
      />
    </section>
  );
}

const PRESET_SETTING_LABEL: Record<keyof BoardPresetSettings, MessageKey> = {
  autonomous: "settings.presets.setting.autonomous",
  concurrencyCap: "settings.presets.setting.concurrencyCap",
  defaultReview: "settings.presets.setting.defaultReview",
  defaultReportSchema: "settings.presets.setting.defaultReportSchema",
  defaultAllowCommit: "settings.presets.setting.defaultAllowCommit",
};

/** Prototype face labels (Configuracoes.dc.html) mapped onto board-preset ids. */
const PRESET_FACE: Record<string, { label: MessageKey; hint: MessageKey }> = {
  eficiente: {
    label: "settings.presets.face.eficiente.label",
    hint: "settings.presets.face.eficiente.hint",
  },
  produtivo: {
    label: "settings.presets.face.produtivo.label",
    hint: "settings.presets.face.produtivo.hint",
  },
  maximo: {
    label: "settings.presets.face.maximo.label",
    hint: "settings.presets.face.maximo.hint",
  },
};

function describePresetValue(
  setting: keyof BoardPresetSettings,
  value: BoardPresetSettings[keyof BoardPresetSettings],
): string {
  if (value === null) return t("settings.presets.value.unset");
  if (setting === "autonomous") return value ? t("settings.presets.value.on") : t("settings.presets.value.off");
  if (setting === "defaultReview") return t("settings.presets.value.reviewWanted");
  if (setting === "defaultAllowCommit") {
    return value ? t("settings.presets.value.allowCommitTrue") : t("settings.presets.value.allowCommitFalse");
  }
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : t("settings.presets.value.unset");
  return String(value);
}

export function ModePage({
  board,
  onToggleAutonomous,
  onSetConcurrencyCap,
  onApplyPreset,
  onSetDefaults,
}: {
  board: SettingsBoard;
  onToggleAutonomous: (id: string, autonomous: boolean) => void;
  onSetConcurrencyCap: (id: string, cap: number | null) => void;
  onApplyPreset: (id: string, preset: BoardPreset) => void;
  onSetDefaults: (
    id: string,
    defaults: { review: "wanted" | null; reportSchema: string[] | null; allowCommit: boolean | null },
  ) => void;
}) {
  const [presets, setPresets] = useState<BoardPreset[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    void window.store.boardPresets().then(setPresets);
  }, []);

  const settings = presetSettingsFromBoard(board, DEFAULT_CONCURRENCY_CAP);
  const matched = presets ? matchPreset(settings, presets) : null;
  const pending = pendingId && presets ? (presets.find((p) => p.id === pendingId) ?? null) : null;
  const changes = pending ? diffPreset(settings, pending.settings) : [];

  return (
    <>
      <span className={styles.hint}>{t("settings.mode.hint")}</span>
      <div className={styles.presetRow}>
        {(presets ?? []).map((preset) => {
          const isCurrent = matched?.id === preset.id;
          const active = pendingId === preset.id || (pendingId == null && isCurrent);
          const face = PRESET_FACE[preset.id];
          return (
            <button
              key={preset.id}
              type="button"
              className={active ? styles.presetActive : styles.preset}
              data-preset-id={preset.id}
              onClick={() => setPendingId((prev) => (prev === preset.id ? null : preset.id))}
            >
              <span className={styles.presetTitle}>
                {face ? t(face.label) : preset.label}
                {isCurrent && <span className={styles.pillCurrent}>{t("settings.presets.badgeCurrent")}</span>}
              </span>
              <span className={styles.hint}>{face ? t(face.hint) : preset.summary}</span>
            </button>
          );
        })}
      </div>
      {pending && (
        <section className={styles.sec} data-preset-diff={pending.id}>
          {changes.length === 0 ? (
            <p className={styles.hint}>{t("settings.presets.noChange")}</p>
          ) : (
            <>
              <h3 className={styles.sh}>{t("settings.presets.willChange")}</h3>
              <ul>
                {changes.map((change) => (
                  <li key={change.setting}>
                    {t(PRESET_SETTING_LABEL[change.setting])}: {describePresetValue(change.setting, change.from)} →{" "}
                    {describePresetValue(change.setting, change.to)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className={styles.hint}>{t("settings.presets.scopeNote")}</p>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.primary}
              disabled={changes.length === 0}
              onClick={() => {
                onApplyPreset(board.id, pending);
                setPendingId(null);
              }}
            >
              {t("settings.presets.apply")}
            </button>
            <button type="button" className={styles.btn} onClick={() => setPendingId(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </section>
      )}
      <section className={styles.sec}>
        <h3 className={styles.sh}>Os ajustes deste board</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("session.autonomous")}</span>
            <span className={styles.hint}>{t("settings.mode.autonomousHint")}</span>
          </div>
          <Switch
            on={board.autonomous}
            label={t("session.autonomous")}
            onToggle={(next) => onToggleAutonomous(board.id, next)}
          />
        </div>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.mode.concurrency")}</span>
            <span className={styles.hint}>{t("settings.mode.concurrencyHint")}</span>
          </div>
          <input
            id="settings-concurrency"
            className={styles.fieldNarrow}
            type="number"
            min={1}
            max={50}
            aria-label={t("settings.mode.concurrency")}
            value={board.concurrency_cap ?? DEFAULT_CONCURRENCY_CAP}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                onSetConcurrencyCap(board.id, null);
                return;
              }
              onSetConcurrencyCap(board.id, Math.max(1, Number(raw)));
            }}
          />
        </div>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.mode.review")}</span>
          </div>
          <select
            className={styles.field}
            aria-label={t("settings.mode.review")}
            value={board.default_review === "wanted" ? "wanted" : ""}
            onChange={(e) => {
              const review = e.target.value === "wanted" ? ("wanted" as const) : null;
              let reportSchema: string[] | null = null;
              if (board.default_report_schema_json) {
                try {
                  const parsed = JSON.parse(board.default_report_schema_json) as unknown;
                  reportSchema = Array.isArray(parsed) ? (parsed as string[]) : null;
                } catch {
                  reportSchema = null;
                }
              }
              const allowCommit =
                board.default_allow_commit === 1 ? true : board.default_allow_commit === 0 ? false : null;
              onSetDefaults(board.id, { review, reportSchema, allowCommit });
            }}
          >
            <option value="">{t("settings.mode.reviewNone")}</option>
            <option value="wanted">{t("settings.mode.reviewWanted")}</option>
          </select>
        </div>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.mode.commit")}</span>
          </div>
          <select
            className={styles.field}
            aria-label={t("settings.mode.commit")}
            value={board.default_allow_commit === 1 ? "allow" : "deny"}
            onChange={(e) => {
              const allowCommit = e.target.value === "allow";
              const review = board.default_review === "wanted" ? ("wanted" as const) : null;
              let reportSchema: string[] | null = null;
              if (board.default_report_schema_json) {
                try {
                  const parsed = JSON.parse(board.default_report_schema_json) as unknown;
                  reportSchema = Array.isArray(parsed) ? (parsed as string[]) : null;
                } catch {
                  reportSchema = null;
                }
              }
              onSetDefaults(board.id, { review, reportSchema, allowCommit });
            }}
          >
            <option value="deny">{t("settings.mode.commitDeny")}</option>
            <option value="allow">{t("settings.mode.commitAllow")}</option>
          </select>
        </div>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.mode.reportFields")}</span>
          </div>
          <span className={`${styles.hint} ${styles.mono}`} data-role="settings-report-fields">
            {(() => {
              if (!board.default_report_schema_json) return t("settings.mode.reportFieldsUnset");
              try {
                const parsed = JSON.parse(board.default_report_schema_json) as unknown;
                if (Array.isArray(parsed) && parsed.length > 0) return parsed.join(" · ");
              } catch {
                /* fall through */
              }
              return board.default_report_schema_json;
            })()}
          </span>
        </div>
      </section>
    </>
  );
}

export function RulesPage({
  board,
  onSetOrchestrator,
}: {
  board: SettingsBoard;
  onSetOrchestrator?: (boardId: string, cardId: string | null) => void;
}) {
  const [rulesText, setRulesText] = useState("");
  const [pathsText, setPathsText] = useState("");
  const [trapCount, setTrapCount] = useState(0);
  const [roles, setRoles] = useState<{ cardId: string; name: string }[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const ctx = await window.store.boardContext.get(board.id);
    if (ctx.ok) {
      setRulesText(ctx.rulesText);
      setPathsText(ctx.gateToolPaths.join("\n"));
      setTrapCount(ctx.trapCount);
    }
    const agentRoles = await window.store.boardAgentRoles(board.id);
    setRoles(
      agentRoles.map((r) => ({
        cardId: r.cardId,
        name: r.label || r.cardId.slice(0, 8),
      })),
    );
  }, [board.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <section className={styles.sec}>
        <div className={styles.row}>
          <h3 className={styles.sh} style={{ flex: 1 }}>
            {t("settings.rules.title")}
          </h3>
          <span className={styles.hint}>{t("settings.rules.hint")}</span>
        </div>
        <textarea
          className={styles.textarea}
          aria-label={t("settings.rules.title")}
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
        />
        <div className={styles.row}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => {
              void window.store.boardContext.setRules(board.id, rulesText).then((r) => {
                setSaved(r.ok ? "ok" : r.error);
                void reload();
              });
            }}
          >
            {t("settings.rules.save")}
          </button>
          {saved && <span className={styles.hint}>{saved}</span>}
        </div>
        <span className={styles.hint}>{t("settings.rules.traps", { n: String(trapCount) })}</span>
      </section>
      <section className={styles.sec}>
        <h3 className={styles.sh}>{t("settings.rules.gates")}</h3>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.rules.isolation")}</span>
            <span className={styles.hint}>{t("settings.rules.isolationHint")}</span>
          </div>
          <Switch on label={t("settings.rules.isolation")} onToggle={() => {}} />
        </div>
        <span className={styles.hint}>{t("settings.rules.isolationOn")}</span>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.rules.toolPaths")}</span>
            <span className={`${styles.hint} ${styles.mono}`}>{t("settings.rules.toolPathsHint")}</span>
          </div>
        </div>
        <textarea
          className={styles.textarea}
          style={{ minHeight: 80 }}
          aria-label={t("settings.rules.toolPaths")}
          value={pathsText}
          onChange={(e) => setPathsText(e.target.value)}
        />
        <button
          type="button"
          className={styles.btn}
          onClick={() => {
            const paths = pathsText.split("\n").map((l) => l.trim()).filter(Boolean);
            void window.store.boardContext.setGateToolPaths(board.id, paths).then(() => void reload());
          }}
        >
          {t("settings.rules.addPath")}
        </button>
      </section>
      <section className={styles.sec}>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.rules.orchestrator")}</span>
            <span className={styles.hint}>{t("settings.rules.orchestratorHint")}</span>
          </div>
          <select
            className={styles.field}
            value={board.orchestrator_card_id ?? ""}
            aria-label={t("settings.rules.orchestrator")}
            onChange={(e) => {
              const v = e.target.value;
              onSetOrchestrator?.(board.id, v === "" ? null : v);
            }}
          >
            <option value="">{t("settings.rules.orchestratorNone")}</option>
            {roles.map((r) => (
              <option key={r.cardId} value={r.cardId}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </section>
    </>
  );
}

export function TeamSettingsPage() {
  const { loggedIn } = useCloudPlan();
  if (!loggedIn) {
    return (
      <section className={styles.sec}>
        <div className={styles.row}>
          <div className={styles.lbl}>
            <span>{t("settings.page.team")}</span>
            <span className={styles.hint}>{t("settings.team.needLogin")}</span>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className={styles.sec}>
      <div className={styles.row}>
        <div className={styles.lbl}>
          <span>{t("settings.team.linked")}</span>
          <span className={styles.hint}>{t("settings.team.hint")}</span>
        </div>
        <button
          type="button"
          className={styles.btn}
          onClick={() => window.dispatchEvent(new CustomEvent("stellar:open-team"))}
        >
          {t("settings.team.open")}
        </button>
      </div>
      <div className={styles.row}>
        <div className={styles.lbl}>
          <span>{t("settings.team.home")}</span>
          <span className={styles.hint}>{t("settings.team.homeHint")}</span>
        </div>
        <Switch on label={t("settings.team.home")} onToggle={() => {}} />
      </div>
    </section>
  );
}

/** Silence unused ReactNode import if tree-shaken oddly — keep for future. */
export type _Keep = ReactNode | typeof Fragment;
