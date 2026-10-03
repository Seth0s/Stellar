/**
 * O MAPA provider → ícone e provider → cor (task b3560898).
 *
 * O ESTADO MEDIDO antes desta task: os ícones de provider existiam em DOIS
 * lugares e nos dois eram INDISTINGUÍVEIS de relance —
 *   - `icons.tsx`'s `providerBash/Claude/Codex/Cursor/Antigravity/Opencode`
 *     (Lucide, metáforas: terminal/robô/código/ponteiro/foguete/caixas) usados
 *     pelo `ProviderPicker` SEM cor nenhuma (herdavam o texto) → todos iguais;
 *   - `provider-glyph.ts`'s `PROVIDER_GLYPH` (glifos do Nerd Font) no header do
 *     card, que nem cobria `opencode` (caía no glifo do bash).
 * E o acento `--accent-<id>` só existia para 5 dos 6 nativos: `opencode` e os
 * genéricos `cline`/`commandcode` caíam no cinza do bash.
 *
 * A DECISÃO, e o porquê de cada eixo:
 *   - DESENHO: SVG PRÓPRIO, inline e versionado (não um conjunto baixado, não
 *     uma URL de terceiro em runtime — offline e privacidade). São marcas
 *     nossas, geométricas e distintas, que GESTICULAM a identidade de cada CLI
 *     sem copiar o logo do fornecedor — copiar a marca de terceiro é problema
 *     de licença, e um asset remoto é problema de offline.
 *   - COR: a família `--accent-<id>` que o card JÁ usa (TerminalCard/cards.css/
 *     xterm). Nada de uma segunda semântica de cor — `--good`/`--warn`/
 *     `--danger` continuam sendo STATUS, e nenhum acento daqui as reusa.
 *   - FALLBACK: um provider SEM marca conhecida (id declarado pelo usuário, ou
 *     um provider novo do app que ainda não tem desenho) recebe o ícone
 *     GENÉRICO em `--muted` — nunca um quadrado vazio.
 *
 * Este módulo é DADO PURO (sem JSX) de propósito: o componente (`provider-icons
 * .tsx`) exporta SÓ componente, para o `react-refresh/only-export-components`
 * não reclamar de um arquivo que mistura componente e dado — a mesma razão que
 * fez `provider-glyph.ts` nascer separado.
 */

/** Os providers que TEM desenho próprio, mais o `generic` (fallback). */
export type ProviderIconKey =
  | "bash"
  | "claude"
  | "codex"
  | "cursor"
  | "antigravity"
  | "opencode"
  | "cline"
  | "commandcode"
  | "generic";

/** Só os que têm marca — o `generic` NÃO entra aqui (é o fallback, não um id). */
export const PROVIDER_ICON_KEYS = [
  "bash",
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "opencode",
  "cline",
  "commandcode",
] as const satisfies readonly ProviderIconKey[];

/**
 * A COR de cada ícone, por token. TODOS são `var()` de token DEFINIDO em
 * `tokens.css` — é o que mantém `check:design-tokens` (camada do `var()`) verde
 * e o que faz o tema claro/escuro funcionar sem nenhum hex novo aqui: o token
 * muda de valor por tema, o ícone segue. O `generic` usa `--muted`, o mesmo
 * neutro que o `--accent-bash` já usa — ausência de marca, honesta.
 */
export const PROVIDER_ACCENT: Record<ProviderIconKey, string> = {
  bash: "var(--accent-bash)",
  claude: "var(--accent-claude)",
  codex: "var(--accent-codex)",
  cursor: "var(--accent-cursor)",
  antigravity: "var(--accent-antigravity)",
  opencode: "var(--accent-opencode)",
  cline: "var(--accent-cline)",
  commandcode: "var(--accent-commandcode)",
  generic: "var(--muted)",
};

/** id → chave de desenho. Desconhecido (ou vazio) → `generic`. */
export function providerIconKey(id: string): ProviderIconKey {
  return (PROVIDER_ICON_KEYS as readonly string[]).includes(id)
    ? (id as ProviderIconKey)
    : "generic";
}

/** id → `var()` da cor. Desconhecido → `--muted`. A cor sai SEMPRE daqui, para
 * o ícone e qualquer outro consumidor não divergirem do mapa. */
export function providerAccentVar(id: string): string {
  return PROVIDER_ACCENT[providerIconKey(id)];
}

/** O nome do token de acento (para data-attrs/testes) — `--accent-claude`,
 * `--muted`, etc. */
export function providerAccentToken(id: string): string {
  return providerAccentVar(id).replace(/^var\(|\)$/g, "");
}
