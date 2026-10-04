/**
 * SAÍDA DE TRANSIÇÕES DO `get_task` (task 6266d3e7) — decisão PURA.
 *
 * PROBLEMA MEDIDO: `get_task` devolve TODAS as `task_transitions`, e as de
 * `kind: "prompt"` carregam o texto `from`/`to` INTEIRO — um prompt de task
 * real tem parágrafos, e um briefing com 3 appends faz o payload do `get_task`
 * dobrar de tamanho sem que o leitor precise daquele texto para decidir o
 * próximo passo. O que o leitor precisa saber é "houve mudança de enunciado,
 * quando, de quem, e de que tamanho" — o texto completo é história, não
 * instrução.
 *
 * O ARMAZENAMENTO NÃO MUDA. `task_transitions.from_value`/`to_value` continuam
 * com o texto completo (é o que `task-transitions.test.ts` fixa, e o que torna
 * o histórico IRRECUPERÁVEL se um dia alguém quiser auditar). A compressão é só
 * da LEITURA: por padrão o `get_task` troca `from`/`to` por
 * `fromLength`/`toLength` + hash curto; `includePromptHistory: true` devolve a
 * linha crua (`from`/`to` completos).
 *
 * Sem I/O, sem store: o chamador passa a transição e a decisão de incluir o
 * histórico, e esta função decide a forma da saída.
 */

import { createHash } from "node:crypto";

export type TaskTransitionOutput = {
  kind: string;
  /** `null` numa transição de prompt resumida (ver `summarized`). */
  from: string | null;
  to: string | null;
  actor: string;
  cardId: string | null;
  at: number;
  /** `true` quando `from`/`to` foram substituídos por tamanho+hash. */
  summarized?: true;
  fromLength?: number | null;
  toLength?: number | null;
  fromHash?: string | null;
  toHash?: string | null;
};

/** Tamanho + hash curto (12 hex) de um valor de transição. `null` = a
 * transição não tinha aquele lado (ex.: primeira escrita). Sem inventar
 * `0`/string vazia para o ausente: `length: 0` descreveria uma string vazia,
 * que é outra coisa. */
export function summarizeTransitionValue(value: unknown): { length: number | null; hash: string | null } {
  if (typeof value !== "string") return { length: null, hash: null };
  return { length: value.length, hash: createHash("sha256").update(value).digest("hex").slice(0, 12) };
}

/**
 * Projeta UMA transição para a saída do `get_task`. Transições que NÃO são de
 * prompt passam intactas (o texto delas é curto — status/declaration/…); só
 * `kind: "prompt"` é resumida, e só quando o chamador não pediu o histórico.
 */
export function projectTransitionForOutput(
  transition: { kind: string; from_value: string | null; to_value: string | null; actor: string; card_id: string | null; at: number },
  includePromptHistory: boolean,
): TaskTransitionOutput {
  const base = {
    kind: transition.kind,
    from: transition.from_value,
    to: transition.to_value,
    actor: transition.actor,
    cardId: transition.card_id,
    at: transition.at,
  };
  if (includePromptHistory || transition.kind !== "prompt") return base;
  const from = summarizeTransitionValue(transition.from_value);
  const to = summarizeTransitionValue(transition.to_value);
  return {
    ...base,
    from: null,
    to: null,
    summarized: true,
    fromLength: from.length,
    toLength: to.length,
    fromHash: from.hash,
    toHash: to.hash,
  };
}
