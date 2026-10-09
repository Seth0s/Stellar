/**
 * Settings V7 shell — docs/design/app-v3/SPEC-Configuracoes-V7.md
 * (prototype Configuracoes.dc.html). Pages live in SettingsPages.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, type Locale } from "../../shared/i18n";
import type { MessageKey } from "../../shared/i18n";
import { useModal } from "./useModal";
import type { BoardPreset } from "../../main/board-preset-decision";
import type { ShortcutCombo, ShortcutOverrides } from "./shortcut-registry";
import {
  decideSettingsPageAfterFilter,
  filterSettingsNav,
  normalizeSettingsPage,
  settingsNavEntry,
  settingsNavForScope,
  settingsScopeLabel,
  type SettingsPageId,
  type SettingsPageRef,
} from "./settings-nav-decision";
import {
  AboutPage,
  AccountPage,
  AppearancePage,
  DevicesPage,
  KeysPage,
  ModePage,
  PerformancePage,
  ProvidersSettingsPage,
  RulesPage,
  ShortcutsPage,
  TeamSettingsPage,
  type SettingsBoard,
} from "./SettingsPages";
import styles from "./SettingsModal.module.css";

export type SettingsPage = SettingsPageRef;
export type { SettingsBoard };

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
  onApplyPreset,
  onSetDefaults,
  onSetOrchestrator,
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
  onApplyPreset: (id: string, preset: BoardPreset) => void;
  onSetDefaults: (
    id: string,
    defaults: { review: "wanted" | null; reportSchema: string[] | null; allowCommit: boolean | null },
  ) => void;
  onSetOrchestrator?: (boardId: string, cardId: string | null) => void;
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

  const [query, setQuery] = useState("");
  const current = normalizeSettingsPage(page);
  const entry = settingsNavEntry(current);

  const labelFor = useCallback((e: { labelKey: string }) => t(e.labelKey as MessageKey), [locale]);

  const appNav = useMemo(() => {
    const base = settingsNavForScope("app");
    return filterSettingsNav(query, base, labelFor);
  }, [query, labelFor]);

  const boardNav = useMemo(() => {
    if (!board) return [];
    const base = settingsNavForScope("board");
    return filterSettingsNav(query, base, labelFor);
  }, [query, board, labelFor]);

  useEffect(() => {
    if (!board && entry.scope === "board") onPageChange("providers");
  }, [board, entry.scope, onPageChange]);

  useEffect(() => {
    const visible = [...appNav, ...boardNav];
    const next = decideSettingsPageAfterFilter(current, visible);
    if (next && next !== current) onPageChange(next);
  }, [appNav, boardNav, current, onPageChange]);

  const scopeInfo = settingsScopeLabel(entry.scope, board);
  const scopeText =
    scopeInfo.key === "settings.scope.boardNamed"
      ? t(scopeInfo.key, scopeInfo.params ?? {})
      : t(scopeInfo.key);

  const boardSecLabel = board
    ? t("settings.nav.boardNamed", { name: board.name || board.id })
    : t("settings.nav.board");

  return (
    <div
      className="modal-root"
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="modal-backdrop" onClick={handleClose} />
      <div
        className={styles.dialog}
        {...modalProps}
        aria-labelledby={titleId}
        data-settings-modal=""
      >
        <nav className={styles.nav} aria-label={t("rail.settings")}>
          <h1 id={titleId} className={styles.title}>
            {t("rail.settings")}
          </h1>
          <label className={styles.search}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#8d94a6" strokeWidth="1.5" aria-hidden="true">
              <circle cx="6" cy="6" r="4.5" />
              <path d="M9.5 9.5L13 13" />
            </svg>
            <input
              className={styles.searchInput}
              aria-label={t("settings.nav.search")}
              placeholder={t("settings.nav.search")}
              value={query}
              data-settings-search=""
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className={styles.secLabel}>{t("settings.nav.app")}</div>
          {appNav.map((item) => (
            <NavButton key={item.id} id={item.id} label={labelFor(item)} isNew={item.isNew} current={current} onPageChange={onPageChange} />
          ))}
          {board && (
            <>
              <div className={styles.secLabelBoard}>{boardSecLabel}</div>
              {boardNav.map((item) => (
                <NavButton key={item.id} id={item.id} label={labelFor(item)} isNew={item.isNew} current={current} onPageChange={onPageChange} />
              ))}
            </>
          )}
        </nav>

        <div className={styles.main}>
          <header className={styles.header}>
            <div className={styles.headerTitles}>
              <h2 className={styles.pageTitle}>{t(entry.labelKey as MessageKey)}</h2>
              <span className={styles.hint}>{t(entry.subtitleKey as MessageKey)}</span>
            </div>
            <span className={styles.spacer} />
            <span className={styles.scope} data-settings-scope="">
              {scopeText}
            </span>
            <button type="button" className={styles.closeBtn} onClick={handleClose} aria-label={t("common.close")} data-settings-close="">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </button>
          </header>
          <div className={styles.pane} data-settings-pane={current}>
            {current === "account" && <AccountPage />}
            {current === "providers" && <ProvidersSettingsPage />}
            {current === "shortcuts" && (
              <ShortcutsPage
                shortcutOverrides={shortcutOverrides}
                onRebind={onRebind}
                onRestoreDefault={onRestoreDefault}
                onRestoreAll={onRestoreAll}
                closeInterceptorRef={closeInterceptorRef}
              />
            )}
            {current === "keys" && <KeysPage />}
            {current === "devices" && <DevicesPage />}
            {current === "appearance" && (
              <AppearancePage locale={locale} onLocaleOverrideChange={onLocaleOverrideChange} />
            )}
            {current === "performance" && <PerformancePage />}
            {current === "general" && <AboutPage />}
            {current === "mode" && board && (
              <ModePage
                board={board}
                onToggleAutonomous={onToggleAutonomous}
                onSetConcurrencyCap={onSetConcurrencyCap}
                onApplyPreset={onApplyPreset}
                onSetDefaults={onSetDefaults}
              />
            )}
            {current === "rules" && board && (
              <RulesPage board={board} onSetOrchestrator={onSetOrchestrator} />
            )}
            {current === "team" && <TeamSettingsPage />}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavButton({
  id,
  label,
  isNew,
  current,
  onPageChange,
}: {
  id: SettingsPageId;
  label: string;
  isNew: boolean;
  current: SettingsPageId;
  onPageChange: (page: SettingsPage) => void;
}) {
  const active = current === id;
  return (
    <button
      type="button"
      className={active ? styles.navItemActive : styles.navItem}
      data-settings-page={id}
      aria-current={active ? "page" : undefined}
      onClick={() => onPageChange(id)}
    >
      {label}
      {isNew && <span className={styles.badgeNew}>{t("settings.nav.new")}</span>}
    </button>
  );
}
