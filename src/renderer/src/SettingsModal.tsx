import { useCallback, useEffect, useRef, useState } from "react";
import { t, SUPPORTED_LOCALES, type Locale } from "../../shared/i18n";
import { Icon, type IconName } from "./icons";
import { useModal } from "./useModal";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SecretsSettingsModal } from "./SecretsSettingsModal";
import { RemotePairingModal } from "./RemotePairingModal";
import type { ShortcutCombo, ShortcutOverrides } from "./shortcut-registry";

/**
 * Settings modal — variant A (`prototypes/settings-modal.html`).
 *
 * The point is SCOPE, not organization. API keys, shortcuts and language
 * apply to the whole app. Concurrent-agent cap and autonomous mode apply
 * only to the open board — and autonomous skips spawn + open-URL consent,
 * so turning it on by mistake is a real consequence. That's why scope is
 * the navigation (Application × This board, board name in the header),
 * not a per-row badge.
 *
 * Pages reuse the existing components (ShortcutsOverlay, SecretsSettingsModal,
 * RemotePairingModal). One implementation, several doors in: `?` opens
 * this modal already on Shortcuts; the rail gear opens General; the
 * topbar QR opens Devices.
 *
 * Geral does NOT invent theme / translucent-cards / terminal-font-size
 * rows from the prototype: dark-first is a design-system decision
 * (`tokens.css`), translucent was removed, and terminal font size is
 * per-card (Ctrl+scroll). Language is the real app-wide setting that
 * used to live in the shortcuts footer.
 *
 * Maestro vs Agentes: autonomous (the orchestration switch) on Maestro;
 * the concurrency cap on Agentes. Both fire immediately, same as when
 * they lived on SessionModal — a safety setting must not wait for Save.
 */

export type SettingsPage = "general" | "shortcuts" | "keys" | "devices" | "maestro" | "agents";

export type SettingsBoard = {
  id: string;
  name: string;
  autonomous: boolean;
  concurrency_cap: number | null;
};

type NavItem = { page: SettingsPage; labelKey: "settings.page.general" | "shortcuts.title" | "settings.page.keys" | "settings.page.devices" | "settings.page.maestro" | "settings.page.agents"; icon: IconName };

const APP_NAV: NavItem[] = [
  { page: "general", labelKey: "settings.page.general", icon: "settings" },
  { page: "shortcuts", labelKey: "shortcuts.title", icon: "keyboard" },
  { page: "keys", labelKey: "settings.page.keys", icon: "apiKey" },
  { page: "devices", labelKey: "settings.page.devices", icon: "remoteControl" },
];

const BOARD_NAV: NavItem[] = [
  { page: "maestro", labelKey: "settings.page.maestro", icon: "sparkle" },
  { page: "agents", labelKey: "settings.page.agents", icon: "chat" },
];

const BOARD_PAGES = new Set<SettingsPage>(["maestro", "agents"]);

export function SettingsModal({
  page,
  onPageChange,
  onClose,
  board,
  shortcutOverrides,
  onRebind,
  onRestoreDefault,
  onRestoreAll,
  locale,
  onLocaleOverrideChange,
  onToggleAutonomous,
  onSetConcurrencyCap,
}: {
  page: SettingsPage;
  onPageChange: (page: SettingsPage) => void;
  onClose: () => void;
  board: SettingsBoard | null;
  shortcutOverrides: ShortcutOverrides;
  onRebind: (id: string, combo: ShortcutCombo) => void;
  onRestoreDefault: (id: string) => void;
  onRestoreAll: () => void;
  locale: Locale;
  onLocaleOverrideChange: (next: Locale | null) => void;
  onToggleAutonomous: (id: string, autonomous: boolean) => void;
  onSetConcurrencyCap: (id: string, cap: number | null) => void;
}) {
  const closeInterceptorRef = useRef<(() => boolean) | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handleClose = useCallback(() => {
    if (closeInterceptorRef.current?.()) return;
    onCloseRef.current();
  }, []);
  const { modalProps } = useModal({ onClose: handleClose });
  const titleId = "settings-modal-title";

  useEffect(() => {
    if (!board && BOARD_PAGES.has(page)) onPageChange("general");
  }, [board, page, onPageChange]);

  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={handleClose} />
      <div className="modal settings-modal" {...modalProps} aria-labelledby={titleId} data-settings-modal="">
        <div className="settings-modal-header">
          <h3 id={titleId}>{t("rail.settings")}</h3>
          <span className="settings-modal-header-spacer" />
          {board && (
            <span className="settings-board-badge" data-settings-board-name="">
              {board.name}
            </span>
          )}
          <button type="button" className="settings-modal-close" onClick={handleClose} aria-label={t("common.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="settings-modal-body">
          <nav className="settings-nav" aria-label={t("rail.settings")}>
            <div className="settings-nav-sec">{t("settings.nav.app")}</div>
            {APP_NAV.map((item) => (
              <NavButton key={item.page} item={item} current={page} onPageChange={onPageChange} />
            ))}
            {board && (
              <>
                <div className="settings-nav-sec">{t("settings.nav.board")}</div>
                {BOARD_NAV.map((item) => (
                  <NavButton key={item.page} item={item} current={page} onPageChange={onPageChange} />
                ))}
              </>
            )}
          </nav>
          <div className="settings-pane" data-settings-pane={page}>
            {page === "general" && <GeneralPage locale={locale} onLocaleOverrideChange={onLocaleOverrideChange} />}
            {page === "shortcuts" && (
              <ShortcutsOverlay
                shortcutOverrides={shortcutOverrides}
                onRebind={onRebind}
                onRestoreDefault={onRestoreDefault}
                onRestoreAll={onRestoreAll}
                closeInterceptorRef={closeInterceptorRef}
              />
            )}
            {page === "keys" && <SecretsSettingsModal />}
            {page === "devices" && <RemotePairingModal />}
            {page === "maestro" && board && (
              <MaestroPage board={board} onToggleAutonomous={onToggleAutonomous} />
            )}
            {page === "agents" && board && (
              <AgentsPage board={board} onSetConcurrencyCap={onSetConcurrencyCap} />
            )}
          </div>
        </div>
        <div className="modal-actions settings-modal-footer">
          <button type="button" className="primary" data-settings-close="" onClick={handleClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function NavButton({
  item,
  current,
  onPageChange,
}: {
  item: NavItem;
  current: SettingsPage;
  onPageChange: (page: SettingsPage) => void;
}) {
  const active = current === item.page;
  return (
    <button
      type="button"
      className={`settings-nav-item${active ? " is-active" : ""}`}
      data-settings-page={item.page}
      aria-current={active ? "page" : undefined}
      onClick={() => onPageChange(item.page)}
    >
      <Icon name={item.icon} size={14} />
      {t(item.labelKey)}
    </button>
  );
}

function GeneralPage({
  locale,
  onLocaleOverrideChange,
}: {
  locale: Locale;
  onLocaleOverrideChange: (next: Locale | null) => void;
}) {
  const [override, setOverride] = useState<Locale | null>(null);
  const [systemLocale, setSystemLocale] = useState("");

  useEffect(() => {
    void window.i18n.get().then((info) => {
      setOverride(info.override);
      setSystemLocale(info.systemLocale);
    });
  }, [locale]);

  const LOCALE_LABEL: Record<Locale, string> = {
    "pt-BR": t("settings.locale.ptBR"),
    en: t("settings.locale.en"),
  };

  return (
    <>
      <div className="settings-row">
        <label htmlFor="settings-locale">
          {t("shortcuts.locale")}
          <small>{t("settings.general.localeHint")}</small>
        </label>
        <select
          id="settings-locale"
          value={override ?? "system"}
          onChange={(e) => {
            const next = e.target.value === "system" ? null : (e.target.value as Locale);
            setOverride(next);
            onLocaleOverrideChange(next);
          }}
          aria-label={t("shortcuts.locale")}
        >
          <option value="system">{t("shortcuts.locale.system", { locale: systemLocale || locale })}</option>
          {SUPPORTED_LOCALES.map((tag) => (
            <option key={tag} value={tag}>
              {LOCALE_LABEL[tag]}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-note">{t("settings.general.scopeNote")}</div>
    </>
  );
}

function MaestroPage({
  board,
  onToggleAutonomous,
}: {
  board: SettingsBoard;
  onToggleAutonomous: (id: string, autonomous: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <label className="autonomous-toggle-label">
        <input
          type="checkbox"
          checked={board.autonomous}
          onChange={(e) => onToggleAutonomous(board.id, e.target.checked)}
        />
        <span>
          {t("session.autonomous")}
          <small>{t("session.autonomousHint")}</small>
          {board.autonomous && <small className="field-error-msg">{t("session.autonomousWarning")}</small>}
        </span>
      </label>
    </div>
  );
}

function AgentsPage({
  board,
  onSetConcurrencyCap,
}: {
  board: SettingsBoard;
  onSetConcurrencyCap: (id: string, cap: number | null) => void;
}) {
  return (
    <div className="settings-row">
      <label htmlFor="settings-concurrency">
        {t("session.concurrency")}
        <small>{t("settings.concurrencyHint")}</small>
      </label>
      <input
        id="settings-concurrency"
        className="concurrency-cap-input"
        type="number"
        min={1}
        max={50}
        placeholder={t("session.concurrencyPlaceholder")}
        value={board.concurrency_cap ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          onSetConcurrencyCap(board.id, raw === "" ? null : Math.max(1, Number(raw)));
        }}
      />
    </div>
  );
}
