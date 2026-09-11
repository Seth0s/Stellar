/**
 * Ícone real de cada provider (2026-09-02, "Terminal, Revisitado") — glyph
 * do MESMO Nerd Font que o app já empacota (`@azurity/pure-nerd-font`,
 * carregado globalmente por main.tsx, também usado como fallback de fonte
 * do próprio xterm.js em useTerminal.ts). Codepoints conferidos no cmap
 * real do arquivo de fonte (fontTools), mesma metáfora que
 * ProviderPicker.tsx já usa hoje com ícones Lucide (bash=terminal,
 * claude=robô, codex=code, cursor=ponteiro, antigravity=foguete). `dark`
 * ausente = chip "flat" (cor sólida, sem gradiente metálico).
 *
 * Extraído de TerminalCard.tsx (2026-09-10, DESIGN-BACKLOG.md §2.1 "Card
 * `task`", Fase 2 peça 4) pro próprio módulo em vez de `export`ado de lá:
 * TaskCard.tsx's card chips precisavam do MESMO glyph metálico sem
 * duplicar a tabela, e exportar uma const de um arquivo de componente
 * dispara `react-refresh/only-export-components` (fast refresh só
 * funciona quando um arquivo só exporta componentes) — um módulo dedicado
 * evita o warning em vez de suprimi-lo.
 */
export const PROVIDER_GLYPH: Record<string, { glyph: string; mid: string; dark?: string }> = {
  bash: { glyph: "", mid: "var(--accent-bash)" }, // fa-terminal
  claude: { glyph: "", mid: "var(--accent-claude)", dark: "var(--accent-claude-dark)" }, // fa-robot
  codex: { glyph: "", mid: "var(--accent-codex)", dark: "var(--accent-codex-dark)" }, // fa-code
  cursor: { glyph: "", mid: "var(--accent-cursor)" }, // fa-mouse_pointer
  antigravity: { glyph: "", mid: "var(--accent-antigravity)", dark: "var(--accent-antigravity-dark)" }, // fa-rocket
};
