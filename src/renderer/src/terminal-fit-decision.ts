/**
 * O primeiro `fit()` do terminal pousou de verdade?
 *
 * RELATO AO VIVO (2026-09-19): "depois de iniciar o app o claude
 * principalmente vem quebrado e precisa de resize" — o card principal
 * (Master, `claude`) renderiza errado logo depois do app abrir e só
 * normaliza com um resize manual da janela/terminal.
 *
 * MEDIDO no fonte que realmente embarca (`node_modules/@xterm/addon-fit/
 * lib/addon-fit.js`, minificado) — `fit()`:
 *
 *   fit(){ const e = this.proposeDimensions();
 *          if(!e || !this._terminal || isNaN(e.cols) || isNaN(e.rows)) return;
 *          ... }
 *
 * Ou seja: quando `proposeDimensions()` devolve `undefined`, `fit()`
 * RETORNA EM SILÊNCIO — sem erro, sem retry, sem sinal nenhum. E o
 * `proposeDimensions` do `FullWidthFitAddon` (useTerminal.ts) devolve
 * `undefined` exatamente nos dois casos de "ainda não dá pra medir":
 * `term.element.parentElement` ausente, ou `dimensions.css.cell.width/
 * height === 0` (métrica de célula ainda não medida pela lib).
 *
 * Consequência no `attach()` de `useTerminal.ts`: o fit é UMA chamada
 * única; se ele der no-op, `term.cols/rows` continuam no default do
 * xterm (80×24, o mesmo valor com que o PTY nasceu — DEFAULT_COLS/
 * DEFAULT_ROWS) e o `pty.resize` logo abaixo reenvia 80×24, um no-op.
 * Nada mais tenta de novo até um resize de verdade (arrastar a borda do
 * card, `onResizeSettled`, ou o refit de 200ms do arraste) — que é
 * literalmente o "só normaliza depois de resize manual" do relato.
 *
 * O segundo caso também protege contra o oposto: uma caixa ainda sem
 * tamanho faz o addon CLAMPAR (`Math.max(2, …)` / `Math.max(1, …)`) e
 * devolver `2×1` — um "fit" que mandaria 2 colunas pro PTY e quebraria a
 * CLI muito mais feio que não fazer nada. Um resultado no PISO do clamp
 * não é uma medida: é uma caixa vazia.
 *
 * Puro — sem xterm, sem DOM, sem I/O. Quem chama (`useTerminal.ts`) mede
 * via `fit.proposeDimensions()` e aplica a decisão.
 */

/** ~2s a 60fps. Generoso de propósito: isto só roda quando a primeira
 * tentativa não pôde medir, e cada tentativa que falha não custa nada
 * além de um `proposeDimensions()` + um frame. */
export const TERMINAL_FIT_MAX_ATTEMPTS = 120;

/** O addon clampa em `max(2, cols)` / `max(1, rows)` — um valor NO piso
 * é caixa vazia, não medida. `3`/`2` são o primeiro valor acima disso. */
export const MIN_MEASURED_COLS = 3;
export const MIN_MEASURED_ROWS = 2;

export type TerminalFitDecision =
  | { action: "fit" }
  | { action: "retry" }
  | { action: "give-up" };

/**
 * `proposed` é o retorno cru de `fit.proposeDimensions()` (`undefined`
 * quando a lib ainda não consegue medir). `attempt` é quantas tentativas
 * já falharam (0 na primeira chamada, logo depois do `term.open()`).
 *
 * `give-up` existe para não girar pra sempre num terminal que nunca vai
 * poder ser medido (card fechado, container permanentemente
 * `display:none`): quem chama simplesmente não mexe no tamanho — nunca
 * inventa um.
 */
export function decideTerminalFit(
  proposed: { cols: number; rows: number } | undefined | null,
  attempt: number,
  maxAttempts: number = TERMINAL_FIT_MAX_ATTEMPTS,
): TerminalFitDecision {
  const measurable =
    !!proposed &&
    Number.isFinite(proposed.cols) &&
    Number.isFinite(proposed.rows) &&
    proposed.cols >= MIN_MEASURED_COLS &&
    proposed.rows >= MIN_MEASURED_ROWS;
  if (measurable) return { action: "fit" };
  if (attempt < maxAttempts) return { action: "retry" };
  return { action: "give-up" };
}
