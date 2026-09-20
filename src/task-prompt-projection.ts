import { parseTaskPrompt } from "./task-prompt-decision";

/**
 * PROJEÇÃO DO PROMPT PARA A FILA — a peça pura da fatia 3c (task ab83ba5f),
 * escrita ANTES da decisão de produto, no mesmo molde do coalescer da 3b:
 * arquivo novo, INERTE (ninguém o importa), contrato em teste.
 *
 * POR QUE ELA EXISTE, medido (seq 509 e a medição de composição):
 *   - o push `task:changed` carrega o prompt INTEIRO de cada task e custa
 *     1,48MB de JSON; 1.001.753 bytes disso são `prompt`+`result_json`;
 *   - dos 377.765 bytes de prompt do board, **88,7% são o ORIGINAL** e só
 *     11% são as adições;
 *   - a LINHA da Fila renderiza `parsedPrompt.original` num clamp de TRÊS
 *     linhas (`TaskCard.module.css`'s `.prompt`, `-webkit-line-clamp: 3`) —
 *     ou seja, ela não tem como mostrar mais do que um punhado de caracteres
 *     numa coluna estreita, enquanto o payload manda 2.616 chars por task em
 *     média (p90 4.803, máximo 7.728);
 *   - com um teto de 400 chars por task o payload do prompt cairia de
 *     368,9KB para 54,4KB (-85,3%); com 200, para 29,8KB (-91,9%).
 *
 * O QUE ESTA PEÇA **NÃO** É: não decide nada de produto. Cortar o prompt do
 * payload exige que a LINHA aceite um preview e que o MODAL (que mostra as
 * adições e edita o texto inteiro) busque o prompt sob demanda — isso é a
 * fiação, e é decisão do dono do repo. Aqui só existe a CONTA: dado um
 * prompt, qual é o texto que a linha precisaria receber.
 *
 * O RISCO QUE ELA MATA POR CONSTRUÇÃO: projetar a string CRUA e cortar os
 * primeiros N caracteres mostraria o separador `---`/`[stellar:added …]` de
 * uma task cujo original é curto e cuja adição é gigante — e o marcador é
 * AGENT-facing (não se traduz, não se mostra como se fosse o pedido). Por
 * isso a projeção PARSEIA antes de cortar: o preview é sempre do original,
 * e o marcador nunca aparece nele.
 */

/**
 * Teto do preview, em caracteres. 400 não é número redondo escolhido por
 * gosto: é folga sobre o clamp de 3 linhas da coluna da Fila (a p90 do
 * original é 4.803 chars, então quase tudo trunca — o que a linha mostra é
 * sempre o começo). Fica exportado pra quem for fiar a 3c ajustar com o
 * mesmo número nos dois lados (payload e UI).
 */
export const TASK_PROMPT_PREVIEW_MAX = 400;

export type TaskPromptProjection = {
  /** O que a linha mostra: o ORIGINAL, cortado no teto. Nunca as adições. */
  preview: string;
  /** `true` quando o original passou do teto — a UI tem como dizer "há mais"
   * sem carregar o resto. */
  truncated: boolean;
};

/** Abaixo disto o corte em espaço custaria contexto demais: corta seco. */
const MIN_USEFUL_RATIO = 0.6;

/** Índice seguro para cortar sem partir um par substituto (emoji no limite
 * da fatia vira caractere inválido se o corte cair no meio do par). */
function safeCut(text: string, at: number): number {
  if (at <= 0 || at >= text.length) return at;
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

export function projectTaskPrompt(
  prompt: string | null | undefined,
  maxChars: number = TASK_PROMPT_PREVIEW_MAX,
): TaskPromptProjection {
  const { original } = parseTaskPrompt(prompt);
  if (!original) return { preview: "", truncated: false };

  const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : TASK_PROMPT_PREVIEW_MAX;
  if (cap === 0) return { preview: "", truncated: original.length > 0 };
  if (original.length <= cap) return { preview: original, truncated: false };

  let end = safeCut(original, cap);
  // Prefere terminar num limite de palavra/quebra — meio-palavra no fim de um
  // clamp de 3 linhas lê como texto corrompido, não como corte.
  const lastBreak = Math.max(original.lastIndexOf(" ", end), original.lastIndexOf("\n", end));
  if (lastBreak >= Math.floor(end * MIN_USEFUL_RATIO)) end = lastBreak;

  return { preview: original.slice(0, end).replace(/\s+$/, ""), truncated: true };
}
