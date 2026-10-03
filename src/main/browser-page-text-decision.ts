/**
 * `get_page_text` COM ESCOPO — decisão PURA (task 3d58046c, lacuna 1).
 *
 * RELATO DO DONO: o Programathor devolvia ~8 mil tokens de lista de
 * tecnologias; `browser_query` com seletor devolveu o MESMO bloco; ele acabou
 * usando `browser_eval` com fatia de string só para não queimar contexto —
 * "O selector é o que falta — hoje é tudo ou nada".
 *
 * MEDIDO no código: `get_page_text` (browser-registry.ts) lia
 * `document.body.innerText` INTEIRO, com um teto FIXO de 20 000 chars e sem
 * seletor nenhum. `browser_query` JÁ é escopado (o seletor vira
 * `querySelector` e o texto do elemento é cortado em 2000), mas o corte dele
 * era MUDO — e é essa a classe que esta casa conserta.
 *
 * A decisão fica aqui, pura e testável; o registry só a executa. Nada de
 * `if (provider === …)` nem de número mágico espalhado: o teto default, o
 * piso e o teto máximo moram AQUI.
 *
 * CORTE NUNCA É MUDO: quem chama usa `describePageTextTruncation` para dizer
 * que cortou e quanto sobrou — um texto truncado sem aviso é a mesma família
 * do snapshot que omite.
 */

/** Teto default: o que já existia, preservado para quem não passa `maxChars`. */
export const DEFAULT_MAX_PAGE_TEXT_CHARS = 20_000;
/** Piso: abaixo disto a leitura seria inútil (e um `maxChars: 0` devolveria ""). */
export const MIN_MAX_PAGE_TEXT_CHARS = 200;
/** Teto MÁXIMO: `maxChars` é pedido do CHAMADOR, não cheque em branco para
 * arrastar megabytes para dentro do contexto — um número absurdo é clampado e
 * o clamp é DITO (`clamped`), nunca obedecido em silêncio. */
export const MAX_MAX_PAGE_TEXT_CHARS = 200_000;

export type PageTextScope = { scope: "selector"; selector: string } | { scope: "body" };

export type PageTextRequestDecision = {
  scope: PageTextScope;
  /** Teto EFETIVO, já clampado. */
  cap: number;
  /** O que o chamador pediu (ou `null` quando omitiu) — para o clamp ser dito. */
  requestedCap: number | null;
  clamped: "below-min" | "above-max" | null;
};

/**
 * Normaliza `{ selector?, maxChars? }`. Seletor vazio/só-espaço = ausente
 * (lê a página inteira, o comportamento de hoje). `maxChars` não-finito ou
 * <=0 = ausente (o default), nunca um `0` que devolveria string vazia.
 */
export function decidePageTextRequest(input: {
  selector?: string | null;
  maxChars?: number | null;
}): PageTextRequestDecision {
  const selector = typeof input.selector === "string" ? input.selector.trim() : "";
  const scope: PageTextScope = selector.length > 0 ? { scope: "selector", selector } : { scope: "body" };

  const requested = typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0 ? Math.floor(input.maxChars) : null;
  if (requested === null) return { scope, cap: DEFAULT_MAX_PAGE_TEXT_CHARS, requestedCap: null, clamped: null };
  if (requested < MIN_MAX_PAGE_TEXT_CHARS) return { scope, cap: MIN_MAX_PAGE_TEXT_CHARS, requestedCap: requested, clamped: "below-min" };
  if (requested > MAX_MAX_PAGE_TEXT_CHARS) return { scope, cap: MAX_MAX_PAGE_TEXT_CHARS, requestedCap: requested, clamped: "above-max" };
  return { scope, cap: requested, requestedCap: requested, clamped: null };
}

/**
 * A frase que acompanha um corte — `null` quando NÃO cortou (nada a dizer).
 * Diz o teto efetivo, o total real e que o resto existe: nunca um corte mudo.
 */
export function describePageTextTruncation(input: {
  truncated: boolean;
  totalChars: number;
  cap: number;
}): string | null {
  if (!input.truncated) return null;
  return (
    `page text truncated: showing the first ${input.cap} of ${input.totalChars} characters ` +
    `(the rest exists and was NOT read — narrow the scope with \`selector\`, or raise \`maxChars\`, instead of assuming the text ends here)`
  );
}
