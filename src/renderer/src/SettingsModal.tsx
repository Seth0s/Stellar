import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t, SUPPORTED_LOCALES, type Locale } from "../../shared/i18n";
import { Icon, type IconName } from "./icons";
import { useModal } from "./useModal";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SecretsSettingsModal } from "./SecretsSettingsModal";
import { RemotePairingModal } from "./RemotePairingModal";
import { ProvidersPage } from "./ProvidersPage";
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
 * this modal already on Shortcuts; the rail gear opens Providers (the
 * default — 2026-09-20, task b2a0a4f8); the topbar QR opens Devices.
 *
 * The page with id `general` is labeled "Sobre" (About) since that is
 * what it actually contains — language, build identity and a scope note
 * — and it sits LAST in the nav. The id stays `general` on purpose: it is
 * a union member (`SettingsPage`) stored in App.tsx's modal state, and
 * renaming it would touch files outside this modal's territory for zero
 * behavioral gain. The divergence id ≠ label is declared here instead of
 * being left mute.
 *
 * Positioning of the fields is NOT per page: `SettingsField` +
 * `.form-row` are the one label/value row, a two-column grid with the
 * value in a fixed column (the measurements and the "before" state live in
 * `layout.css`). The owner reported Sobre "quebrada em espaçamento e
 * quebra de linha" (2026-09-20, task 8ff311e7) — the row used to be flex
 * with the label taking whatever a value with no rule left it. The tab
 * order did NOT change: Sobre stays last, by the same decision below.
 *
 * Sobre does NOT invent theme / translucent-cards / terminal-font-size
 * rows from the prototype: dark-first is a design-system decision
 * (`tokens.css`), translucent was removed, and terminal font size is
 * per-card (Ctrl+scroll). Language is the real app-wide setting that
 * used to live in the shortcuts footer.
 *
 * Maestro vs Agentes: autonomous (the orchestration switch) on Maestro;
 * the concurrency cap on Agentes. Both fire immediately, same as when
 * they lived on SessionModal — a safety setting must not wait for Save.
 *
 * Modal frame height (task b2a0a4f8): STABLE across pages — measured in
 * the real app (CDP harness, 1280×800): natural heights general 405 /
 * providers 742 / shortcuts 941 / keys 513 / devices·maestro·agents 405,
 * so content-driven height jumped 430↔640 when switching tabs. The frame
 * now answers to the viewport only (`layout.css`: `height: min(720px,
 * 80vh)`); `.settings-pane` stays the one scroller.
 */

export type SettingsPage = "general" | "shortcuts" | "keys" | "devices" | "maestro" | "agents" | "providers";

export type SettingsBoard = {
  id: string;
  name: string;
  autonomous: boolean;
  concurrency_cap: number | null;
};

type NavItem = { page: SettingsPage; labelKey: "settings.page.about" | "shortcuts.title" | "settings.page.keys" | "settings.page.devices" | "settings.page.maestro" | "settings.page.agents" | "settings.page.providers"; icon: IconName };

// Providers first — the rail gear's DEFAULT (task b2a0a4f8, decided on
// measured grounds: most-used page, and the providers.json watcher makes
// it the one that reflects an external edit within ~300ms). "Sobre" last.
// The last item KEEPS the page id `general` on purpose — see the file
// header for why id and label intentionally diverge.
const APP_NAV: NavItem[] = [
  { page: "providers", labelKey: "settings.page.providers", icon: "wrench" },
  { page: "shortcuts", labelKey: "shortcuts.title", icon: "keyboard" },
  { page: "keys", labelKey: "settings.page.keys", icon: "apiKey" },
  { page: "devices", labelKey: "settings.page.devices", icon: "remoteControl" },
  { page: "general", labelKey: "settings.page.about", icon: "settings" },
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
    // No board → board pages render nothing, so this redirect must land on
    // a page that EXISTS without a board. That is the default page
    // (providers — task b2a0a4f8); maestro/agents never qualify.
    if (!board && BOARD_PAGES.has(page)) onPageChange("providers");
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
            {page === "general" && <AboutPage locale={locale} onLocaleOverrideChange={onLocaleOverrideChange} />}
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
            {page === "providers" && <ProvidersPage />}
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

/**
 * A linha rótulo/valor das configurações — o posicionamento dos campos
 * mora AQUI, uma vez, e não em cada aba. Serve as páginas deste modal
 * hoje e a próxima que precisar de um campo: rótulo + hint à esquerda,
 * valor à direita, nas mesmas duas verticais de `.form-row`
 * (`layout.css`) — que é onde o porquê da grade está medido.
 *
 * `htmlFor` associa o rótulo ao controle quando a linha tem um. A
 * identidade da build não tem — ela é leitura, não campo — e por isso é
 * a única chamada que não passa `htmlFor` (o `<label>` fica só com o
 * texto de apoio, como já estava).
 *
 * Exceção declarada: a linha cujo controle É o rótulo (o checkbox do modo
 * autônomo, em `MaestroPage`) não passa por aqui — ela não tem coluna de
 * valor, e o `.autonomous-toggle-label` ocupa as duas colunas.
 */
function SettingsField({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="form-row">
      <label htmlFor={htmlFor}>
        {label}
        <small>{hint}</small>
      </label>
      {children}
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

// Rendered for page id `general`, labeled "Sobre" — see the file header.
function AboutPage({
  locale,
  onLocaleOverrideChange,
}: {
  locale: Locale;
  onLocaleOverrideChange: (next: Locale | null) => void;
}) {
  const [override, setOverride] = useState<Locale | null>(null);
  const [systemLocale, setSystemLocale] = useState("");
  // The identity as PARTS, not one string: it is long enough to wrap, and
  // it must wrap between the parts (label · version · bus) — never inside
  // one, which is where "bus / protocol 4" came from. `title` joins them
  // back for the case where the value is clipped anyway.
  const [buildParts, setBuildParts] = useState<string[] | null>(null);

  useEffect(() => {
    void window.i18n.get().then((info) => {
      setOverride(info.override);
      setSystemLocale(info.systemLocale);
    });
    void window.system.getBuildIdentity().then((id) => {
      setBuildParts([id.label, `v${id.version}`, `bus protocol ${id.busProtocol}`]);
    });
  }, [locale]);

  const LOCALE_LABEL: Record<Locale, string> = {
    "pt-BR": t("settings.locale.ptBR"),
    en: t("settings.locale.en"),
  };

  return (
    <>
      <SettingsField
        label={t("shortcuts.locale")}
        hint={t("settings.general.localeHint")}
        htmlFor="settings-locale"
      >
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
      </SettingsField>
      <SettingsField
        label={t("settings.general.buildIdentity")}
        hint={t("settings.general.buildIdentityHint")}
      >
        <code data-settings-build-identity="" title={buildParts?.join(" · ")}>
          {buildParts
            ? buildParts.map((part, i) => (
                <Fragment key={part}>
                  {i > 0 && " · "}
                  <span className="settings-build-part">{part}</span>
                </Fragment>
              ))
            : t("settings.general.buildIdentityLoading")}
        </code>
      </SettingsField>
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
    <div className="form-row">
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
    <SettingsField
      label={t("session.concurrency")}
      hint={t("settings.concurrencyHint")}
      htmlFor="settings-concurrency"
    >
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
    </SettingsField>
  );
}
