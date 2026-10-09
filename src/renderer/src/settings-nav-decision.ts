/**
 * Settings navigation catalog and pure filters for the v3 Configurações shell
 * (`docs/design/app-v3/prototipo/Configuracoes.dc.html`).
 *
 * Search and scope labels stay data-driven so unit tests prove the filter
 * without mounting the modal.
 */

export type SettingsScope = "app" | "board";

export type SettingsPageId =
  | "account"
  | "providers"
  | "shortcuts"
  | "keys"
  | "devices"
  | "appearance"
  | "performance"
  | "general"
  | "mode"
  | "rules"
  | "team";

/** Legacy page ids that still arrive from older callers / tests. */
export type LegacySettingsPageId = "maestro" | "agents";

export type SettingsPageRef = SettingsPageId | LegacySettingsPageId;

export type SettingsNavEntry = {
  id: SettingsPageId;
  scope: SettingsScope;
  /** i18n key for the nav label and pane title. */
  labelKey: string;
  /** i18n key for the one-line subtitle under the title. */
  subtitleKey: string;
  /** Shown as a "novo" pill while the section is new in the product. */
  isNew: boolean;
  /** Lowercase tokens that the search box matches (label + synonyms). */
  searchTokens: readonly string[];
};

/**
 * Application × This board catalog — order matches the approved prototype.
 * `general` keeps the Sobre id used by App.tsx (`setSettingsPage("general")`).
 */
export const SETTINGS_NAV: readonly SettingsNavEntry[] = [
  {
    id: "account",
    scope: "app",
    labelKey: "settings.page.account",
    subtitleKey: "settings.subtitle.account",
    isNew: true,
    searchTokens: ["conta", "plano", "account", "plan", "casa", "work home", "sync"],
  },
  {
    id: "providers",
    scope: "app",
    labelKey: "settings.page.providers",
    subtitleKey: "settings.subtitle.providers",
    isNew: false,
    searchTokens: ["providers", "cli", "cota", "quota", "mcp"],
  },
  {
    id: "shortcuts",
    scope: "app",
    labelKey: "shortcuts.title",
    subtitleKey: "settings.subtitle.shortcuts",
    isNew: false,
    searchTokens: ["atalhos", "shortcuts", "tecla", "keyboard", "hotkey"],
  },
  {
    id: "keys",
    scope: "app",
    labelKey: "settings.page.keys",
    subtitleKey: "settings.subtitle.keys",
    isNew: false,
    searchTokens: ["chaves", "api", "keys", "secrets", "anthropic", "openai"],
  },
  {
    id: "devices",
    scope: "app",
    labelKey: "settings.page.devices",
    subtitleKey: "settings.subtitle.devices",
    isNew: false,
    searchTokens: ["dispositivos", "devices", "celular", "mobile", "parear", "pair"],
  },
  {
    id: "appearance",
    scope: "app",
    labelKey: "settings.page.appearance",
    subtitleKey: "settings.subtitle.appearance",
    isNew: true,
    searchTokens: ["aparencia", "appearance", "idioma", "locale", "fonte", "font", "movimento", "motion"],
  },
  {
    id: "performance",
    scope: "app",
    labelKey: "settings.page.performance",
    subtitleKey: "settings.subtitle.performance",
    isNew: true,
    searchTokens: ["desempenho", "performance", "fps", "scrollback", "background", "segundo plano"],
  },
  {
    id: "general",
    scope: "app",
    labelKey: "settings.page.about",
    subtitleKey: "settings.subtitle.about",
    isNew: false,
    searchTokens: ["sobre", "about", "versao", "version", "build", "atualizacao", "update", "relay"],
  },
  {
    id: "mode",
    scope: "board",
    labelKey: "settings.page.mode",
    subtitleKey: "settings.subtitle.mode",
    isNew: false,
    searchTokens: ["modo", "mode", "maestro", "agentes", "agents", "autonomo", "autonomous", "preset", "concorrencia"],
  },
  {
    id: "rules",
    scope: "board",
    labelKey: "settings.page.rules",
    subtitleKey: "settings.subtitle.rules",
    isNew: true,
    searchTokens: ["regras", "rules", "gates", "orquestrador", "orchestrator", "board-context", "contexto"],
  },
  {
    id: "team",
    scope: "board",
    labelKey: "settings.page.team",
    subtitleKey: "settings.subtitle.team",
    isNew: true,
    searchTokens: ["time", "team", "equipe"],
  },
] as const;

const BY_ID = new Map(SETTINGS_NAV.map((e) => [e.id, e]));

/** Map legacy Maestro/Agentes ids onto the merged "Modo de trabalho" page. */
export function normalizeSettingsPage(page: SettingsPageRef): SettingsPageId {
  if (page === "maestro" || page === "agents") return "mode";
  return page;
}

export function settingsNavEntry(page: SettingsPageRef): SettingsNavEntry {
  const id = normalizeSettingsPage(page);
  return BY_ID.get(id) ?? SETTINGS_NAV[0]!;
}

export function settingsNavForScope(scope: SettingsScope): SettingsNavEntry[] {
  return SETTINGS_NAV.filter((e) => e.scope === scope);
}

/**
 * Case-insensitive substring match over label tokens. Empty query → all entries.
 * Matching is on the catalog tokens plus the resolved label text the UI passes in
 * (so i18n strings participate without the decision importing the catalog).
 */
export function filterSettingsNav(
  query: string,
  entries: readonly SettingsNavEntry[],
  labelFor: (entry: SettingsNavEntry) => string,
): SettingsNavEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  return entries.filter((entry) => {
    const haystack = [...entry.searchTokens, labelFor(entry), entry.id].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

/** Scope chip copy — board name when known, otherwise a generic board scope. */
export function settingsScopeLabel(
  scope: SettingsScope,
  board: { id: string; name: string } | null,
): { key: "settings.scope.app" | "settings.scope.board" | "settings.scope.boardNamed"; params?: Record<string, string> } {
  if (scope === "app") return { key: "settings.scope.app" };
  if (board?.name) return { key: "settings.scope.boardNamed", params: { name: board.name } };
  if (board?.id) return { key: "settings.scope.boardNamed", params: { name: board.id } };
  return { key: "settings.scope.board" };
}

/**
 * When search hides the current page, pick the first visible entry (app first,
 * then board). `null` means nothing matches — keep the current page mounted.
 */
export function decideSettingsPageAfterFilter(
  current: SettingsPageId,
  visible: readonly SettingsNavEntry[],
): SettingsPageId | null {
  if (visible.some((e) => e.id === current)) return current;
  return visible[0]?.id ?? null;
}
