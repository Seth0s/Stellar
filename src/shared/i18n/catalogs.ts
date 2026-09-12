/**
 * DESIGN-BACKLOG.md §2.1 "Internacionalizacao" — FASE 1.
 *
 * Typed catalogs: `pt-BR` is the source of truth (`as const`); `en` is
 * `Record<MessageKey, string>` so a missing key is a compile error, not a
 * silent runtime fallback. Same structural-impossibility posture as the
 * closed shortcut registry.
 *
 * Phase 1 only ships the strings for the few screens migrated as proof.
 * Phase 2 sweeps the rest per file — do NOT bulk-extract the ~400 UI
 * strings into this file until phase 1 is approved.
 */

export const ptBR = {
  "confirm.cancel": "Cancelar",

  "app.closeTerminal.title": "Fechar terminal?",
  "app.closeTerminal.message":
    "{name} ainda está rodando — fechar encerra o processo agora, sem como desfazer.",
  "app.closeTerminal.confirm": "Fechar",
  "app.openUrl.title": "Abrir link no navegador",
  "app.openUrl.message": 'Abrir "{url}" no navegador interno deste agente?',
  "app.openUrl.confirm": "Abrir",
  "app.browserPermission.title": "Permissão do navegador",
  "app.browserPermission.confirm": "Permitir",
  "app.export.cancel": "Cancelar",

  "menu.edit": "Editar",
  "menu.view": "Exibir",
  "menu.back": "Voltar",
  "menu.forward": "Avançar",
  "menu.reload": "Recarregar",
  "menu.openLink": "Abrir link",
  "menu.copyLinkAddress": "Copiar endereço do link",
  "menu.copyImageAddress": "Copiar endereço da imagem",
  "menu.copy": "Copiar",
  "menu.cut": "Recortar",
  "menu.paste": "Colar",
  "menu.inspectElement": "Inspecionar elemento",

  "shortcuts.title": "Atalhos",
  "shortcuts.mode.view": "Ver",
  "shortcuts.mode.configure": "Configurar",
  "shortcuts.customized": "personalizado",
  "shortcuts.restoreDefault": "Restaurar padrão",
  "shortcuts.restoreAll": "Restaurar todos",
  "shortcuts.recording": "Pressione a nova combinação…",
  "shortcuts.recordingError.reserved": "Esta tecla é reservada e não pode ser reatribuída.",
  "shortcuts.confirm.rebind": "Reatribuir",
  "shortcuts.locale": "Idioma",
  "shortcuts.locale.system": "Sistema ({locale})",

  "home.neverAccessed": "nunca acessado",
  "home.accessed": "acessado {when}",
  "home.created": "criado {when}",
  "home.recent": "recente",
} as const;

export type MessageKey = keyof typeof ptBR;

export const en: Record<MessageKey, string> = {
  "confirm.cancel": "Cancel",

  "app.closeTerminal.title": "Close terminal?",
  "app.closeTerminal.message":
    "{name} is still running — closing ends the process now, with no undo.",
  "app.closeTerminal.confirm": "Close",
  "app.openUrl.title": "Open link in browser",
  "app.openUrl.message": 'Open "{url}" in this agent\'s built-in browser?',
  "app.openUrl.confirm": "Open",
  "app.browserPermission.title": "Browser permission",
  "app.browserPermission.confirm": "Allow",
  "app.export.cancel": "Cancel",

  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.back": "Back",
  "menu.forward": "Forward",
  "menu.reload": "Reload",
  "menu.openLink": "Open link",
  "menu.copyLinkAddress": "Copy link address",
  "menu.copyImageAddress": "Copy image address",
  "menu.copy": "Copy",
  "menu.cut": "Cut",
  "menu.paste": "Paste",
  "menu.inspectElement": "Inspect element",

  "shortcuts.title": "Shortcuts",
  "shortcuts.mode.view": "View",
  "shortcuts.mode.configure": "Configure",
  "shortcuts.customized": "custom",
  "shortcuts.restoreDefault": "Restore default",
  "shortcuts.restoreAll": "Restore all",
  "shortcuts.recording": "Press the new combination…",
  "shortcuts.recordingError.reserved": "This key is reserved and cannot be rebound.",
  "shortcuts.confirm.rebind": "Rebind",
  "shortcuts.locale": "Language",
  "shortcuts.locale.system": "System ({locale})",

  "home.neverAccessed": "never opened",
  "home.accessed": "opened {when}",
  "home.created": "created {when}",
  "home.recent": "recent",
};

export const CATALOGS = {
  "pt-BR": ptBR,
  en,
} as const;

export type Locale = keyof typeof CATALOGS;

export const SUPPORTED_LOCALES: readonly Locale[] = ["pt-BR", "en"];
