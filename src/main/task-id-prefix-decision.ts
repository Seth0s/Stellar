/**
 * RESOLUÇÃO DE ID CURTO (task 6266d3e7) — decisão PURA.
 *
 * PROBLEMA MEDIDO: `get_task("0871b484")` (prefixo de 8) respondia "no such
 * task", mas os relatórios e a conversa usam esse prefixo o tempo todo. Toda
 * tool que recebe `taskId` passa a aceitar um prefixo ÚNICO de >= 8 caracteres;
 * prefixo ambíguo é RECUSADO listando os candidatos (nunca adivinha).
 */

export type TaskIdResolution =
  | { ok: true; id: string }
  | { ok: false; reason: "too-short" | "not-found" | "ambiguous"; candidates?: string[] };

export const MIN_TASK_ID_PREFIX = 8;

export function resolveTaskIdPrefix(query: string, ids: readonly string[]): TaskIdResolution {
  const q = query.trim();
  if (q.length < MIN_TASK_ID_PREFIX) return { ok: false, reason: "too-short" };
  // Id EXATO sempre vence (um id que por acaso começa com outro ainda resolve
  // para ele mesmo).
  if (ids.includes(q)) return { ok: true, id: q };
  const matches = ids.filter((id) => id.startsWith(q));
  if (matches.length === 1) return { ok: true, id: matches[0]! };
  if (matches.length === 0) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "ambiguous", candidates: matches };
}

/** O id curto exibido em avisos/relatórios (8 chars). */
export function shortTaskId(id: string): string {
  return id.slice(0, MIN_TASK_ID_PREFIX);
}
