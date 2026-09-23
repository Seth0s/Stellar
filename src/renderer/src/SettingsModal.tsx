import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t, SUPPORTED_LOCALES, type Locale } from "../../shared/i18n";
import { Icon, type IconName } from "./icons";
import { StellarMark } from "./StellarMark";
import { useModal } from "./useModal";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { SecretsSettingsModal } from "./SecretsSettingsModal";
import { RemotePairingModal } from "./RemotePairingModal";
import { ProvidersPage } from "./ProvidersPage";
import {
  diffPreset,
  matchPreset,
  presetSettingsFromBoard,
  type BoardPreset,
  type BoardPresetSettings,
} from "../../main/board-preset-decision";
import { DEFAULT_CONCURRENCY_CAP } from "./task-board-model";
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
  /** BOARD PRESETS, FASE 2 — os defaults de contrato do board, do jeito que o
   * banco os guarda (JSON TEXT / 0-1 INTEGER). Opcionais: são lidos pelo módulo
   * puro (`presetSettingsFromBoard`), que já tolera ausência. */
  default_review?: string | null;
  default_report_schema_json?: string | null;
  default_allow_commit?: number | null;
};

/** Rótulo humano de cada ajuste do diff ("isto vai mudar: …"). */
const PRESET_SETTING_LABEL: Record<keyof BoardPresetSettings, Parameters<typeof t>[0]> = {
  autonomous: "settings.presets.setting.autonomous",
  concurrencyCap: "settings.presets.setting.concurrencyCap",
  defaultReview: "settings.presets.setting.defaultReview",
  defaultReportSchema: "settings.presets.setting.defaultReportSchema",
  defaultAllowCommit: "settings.presets.setting.defaultAllowCommit",
};

/**
 * O valor de um ajuste em texto HUMANO. `null` é sempre "não declarado" — a UI
 * nunca escreve "desligado" para o que ninguém decidiu, porque essa é
 * exatamente a diferença que o default carrega (`false` = não commitar;
 * `null` = ninguém decidiu).
 */
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
  onApplyPreset,
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
  /** BOARD PRESETS, FASE 2 — aplica o preset inteiro. A escrita mora no
   * `useBoardStore` (que é quem tem o estado dos boards): este modal desenha o
   * diff e pede, nunca escreve por conta própria. */
  onApplyPreset: (id: string, preset: BoardPreset) => void;
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
              <MaestroPage board={board} onToggleAutonomous={onToggleAutonomous} onApplyPreset={onApplyPreset} />
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
  // A identidade chega em DOIS pedaços, e por motivos diferentes: a VERSÃO é a
  // resposta de relance ("que app é este e em que versão?") e fica no bloco de
  // cima; os PARTS são procedência (commit/data e protocolo do bus) e quebram
  // ENTRE si, nunca dentro de um — é de onde saía o "bus / protocol 4". A
  // versão NÃO se repete embaixo: repetir é convidar os dois números a
  // divergirem, e o de baixo só é bom se for o mesmo.
  const [build, setBuild] = useState<{ version: string; parts: string[] } | null>(null);

  useEffect(() => {
    void window.i18n.get().then((info) => {
      setOverride(info.override);
      setSystemLocale(info.systemLocale);
    });
    void window.system.getBuildIdentity().then((id) => {
      setBuild({ version: id.version, parts: [id.label, `bus protocol ${id.busProtocol}`] });
    });
  }, [locale]);

  // `unknown` é a resposta honesta da main quando nenhum `package.json` do app
  // respondeu: numa tela de procedência, dizer que não sabe é melhor que
  // mostrar um número errado (ver `appVersion()` em `main/index.ts`).
  const versionText = build
    ? build.version === "unknown"
      ? t("settings.about.versionUnknown")
      : `v${build.version}`
    : t("settings.general.buildIdentityLoading");

  const LOCALE_LABEL: Record<Locale, string> = {
    "pt-BR": t("settings.locale.ptBR"),
    en: t("settings.locale.en"),
  };

  return (
    <>
      {/* IDENTIDADE — bloco, não linha de formulário: ícone (a MESMA arte de
          `build/icon.svg`, via `StellarMark`), nome e versão de relance. A
          versão anterior tentava dizer isto numa `.form-row`, com a tela
          virando três dados espremidos em 300px de mono. É o caso da REGRA DE
          VARIANTE (§8.1 do SYSTEM_DESIGN): Sobre não é `label|controle`.
          "Stellar" não é traduzido: é nome próprio, igual nos dois idiomas. */}
      <div className="about-identity" data-settings-identity="">
        <StellarMark size={40} />
        <div className="about-identity-name">Stellar</div>
        <div className="about-identity-version" data-settings-version="">
          {versionText}
        </div>
      </div>

      {/* PROCEDÊNCIA — em largura cheia e legível, com o aviso que existe para
          o caso real de hoje: o dono testando uma build sem saber se o conserto
          estava dentro. Este texto NÃO sai. */}
      <div className="about-build" data-settings-build-identity="">
        <div className="about-build-label">{t("settings.general.buildIdentity")}</div>
        <div className="about-build-parts">
          {build
            ? build.parts.map((part, i) => (
                <Fragment key={part}>
                  {i > 0 && " · "}
                  <span className="settings-build-part">{part}</span>
                </Fragment>
              ))
            : t("settings.general.buildIdentityLoading")}
        </div>
        <p className="about-build-hint">{t("settings.general.buildIdentityHint")}</p>
      </div>

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
      <div className="settings-note">{t("settings.general.scopeNote")}</div>
    </>
  );
}

function MaestroPage({
  board,
  onToggleAutonomous,
  onApplyPreset,
}: {
  board: SettingsBoard;
  onToggleAutonomous: (id: string, autonomous: boolean) => void;
  onApplyPreset: (id: string, preset: BoardPreset) => void;
}) {
  const [presets, setPresets] = useState<BoardPreset[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Os presets vêm do MAIN (um ponto de leitura só — ver main/board-presets.ts):
  // uma cópia do JSON no renderer divergiria no primeiro ajuste mexido, e a UI
  // diria "Produtivo" com os números de outro preset.
  useEffect(() => {
    void window.store.boardPresets().then(setPresets);
  }, []);

  const settings = presetSettingsFromBoard(board, DEFAULT_CONCURRENCY_CAP);
  const matched = presets ? matchPreset(settings, presets) : null;
  // `matchPreset` devolve o preset OU `{id:"custom"}` — sem rótulo. A leitura
  // nomeada ("este board está em X") só existe quando o ajuste REALMENTE bate:
  // nunca escrevemos o nome de um preset que os ajustes já não satisfazem.
  const matchedLabel =
    !presets
      ? t("settings.presets.loading")
      : matched && "label" in matched
        ? matched.label
        : t("settings.presets.custom");
  const pending = pendingId && presets ? (presets.find((p) => p.id === pendingId) ?? null) : null;
  const changes = pending ? diffPreset(settings, pending.settings) : [];

  return (
    <>
      {/* BOARD PRESETS (task 83f4cfa3) — a ORQUESTRAÇÃO do board num só lugar:
          modo autônomo, teto de concorrência e os defaults de contrato. Fica no
          Maestro (e não numa aba nova) porque é aqui que o switch de orquestração
          já mora — e o diff NOMEIA cada ajuste que muda, inclusive o teto, que
          tem seu próprio campo na aba Agentes. */}
      <div className="preset-block" data-preset-block="">
        <div className="preset-title">{t("settings.presets.title")}</div>
        <div className="preset-current" data-preset-current={matched?.id ?? "loading"}>
          {t("settings.presets.current")} <strong>{matchedLabel}</strong>
        </div>
        <p className="settings-note">{t("settings.presets.hint")}</p>

        <ul className="preset-list">
          {(presets ?? []).map((preset) => {
            const isCurrent = matched?.id === preset.id;
            return (
              <li
                key={preset.id}
                className={`preset-option${isCurrent ? " is-current" : ""}${pendingId === preset.id ? " is-pending" : ""}`}
                data-preset-option={preset.id}
              >
                <button
                  type="button"
                  className="preset-option-btn"
                  data-preset-id={preset.id}
                  aria-pressed={pendingId === preset.id}
                  onClick={() => setPendingId((prev) => (prev === preset.id ? null : preset.id))}
                >
                  {preset.label}
                  {isCurrent && <span className="preset-badge">{t("settings.presets.badgeCurrent")}</span>}
                </button>
                <p className="preset-option-summary">{preset.summary}</p>
                {/* Custo dito HONESTAMENTE: o texto vem do dado, e o link é a
                    página dos três jeitos. Nenhum número de token nasce aqui —
                    "custa muitas vezes mais" é o que se sabe. */}
                <p className="preset-option-cost" data-preset-cost={preset.id}>
                  {preset.costNotice}
                  {preset.docsUrl && (
                    <>
                      {" "}
                      <a href={preset.docsUrl} target="_blank" rel="noreferrer" data-preset-docs={preset.id}>
                        {t("settings.presets.docsLink")}
                      </a>
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>

        {pending && (
          <div className="preset-diff" data-preset-diff={pending.id}>
            {changes.length === 0 ? (
              <p className="preset-diff-none" data-preset-no-change="">
                {t("settings.presets.noChange")}
              </p>
            ) : (
              <>
                <div className="preset-diff-title">{t("settings.presets.willChange")}</div>
                <ul className="preset-diff-list">
                  {changes.map((change) => (
                    <li key={change.setting} data-preset-change={change.setting}>
                      <span className="preset-diff-label">{t(PRESET_SETTING_LABEL[change.setting])}</span>
                      <span className="preset-diff-from">{describePresetValue(change.setting, change.from)}</span>
                      {" → "}
                      <span className="preset-diff-to">{describePresetValue(change.setting, change.to)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {/* A promessa que a UI tem de fazer em texto: nada do que já está
                rodando muda — o preset é default do que vem a seguir. */}
            <p className="settings-note">{t("settings.presets.scopeNote")}</p>
            <div className="preset-diff-actions">
              <button
                type="button"
                className="preset-apply"
                data-preset-apply={pending.id}
                disabled={changes.length === 0}
                onClick={() => {
                  onApplyPreset(board.id, pending);
                  setPendingId(null);
                }}
              >
                {t("settings.presets.apply")}
              </button>
              <button type="button" data-preset-cancel="" onClick={() => setPendingId(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>

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
    </>
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
