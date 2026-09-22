/**
 * QUAL TASK É A DE UM `report` — resolvida UMA vez, para as DUAS portas.
 *
 * POR QUE ESTE MÓDULO EXISTE (task 4fee76d5, medido em 2026-09-20):
 * as duas portas do `report` resolviam a task por conta própria e com regras
 * diferentes, e as duas entregavam `null` quando não conseguiam decidir. Como
 * `null` já significava "não tem vínculo nenhum" — e outsider PODE emitir
 * veredito —, um card com 2+ vínculos ativos deixava de ser reconhecido como
 * implementer e passava a poder assinar o próprio trabalho.
 *
 * MEDIDO antes do conserto (teste de caracterização, 2 falhas + 3 controles):
 *   - MCP: card principal de 2 tasks running → veredito ACEITO (`ok: true`);
 *   - BUS: card com 2 linhas em `task_cards` e sem ser principal → idem;
 *   - controles: 1 vínculo recusa pelo papel; `taskId` declarado resolve;
 *     `taskId` declarado que não é vínculo vivo recusa.
 * No banco real: 4 cards de 264 tinham 2+ vínculos vivos — os de
 * orquestrador/agente, que são justamente os que mais reportam.
 *
 * A REGRA, e por que cada parte dela:
 *   - o `taskId` DECLARADO pelo agente vence. O que salvou o card que
 *     reportou este bug foi a declaração — e é justamente ela que o bus
 *     ignorava: os agentes já escrevem `taskId` no corpo por convenção do
 *     board, e era o único campo que dizia, sem ambiguidade, de qual task
 *     era o relatório. Declarado que NÃO corresponde a vínculo vivo é
 *     RECUSA, não fallback silencioso — cair para outro vínculo seria
 *     responder sobre uma task que o agente não pediu.
 *   - sem declaração: UM vínculo é inequívoco; DOIS ou mais é AMBÍGUO, e
 *     ambíguo RECUSA nomeando as candidatas. Nunca desempata, nunca
 *     degrada para outsider.
 *   - NENHUM vínculo continua sendo `unknown` → outsider, que é a política
 *     que já existe (`decideReportVerdictWrite`): mudar isso seria inventar
 *     política nova, não consertar um buraco.
 *
 * `ambiguous` e `unknown` são AÇÕES DIFERENTES de propósito: era a fusão dos
 * dois num `null` só que criava o buraco de autorização.
 */

export type ReportTaskLink =
  | { action: "resolve"; taskId: string; source: "declared" | "principal" | "link" }
  | { action: "ambiguous"; candidates: string[] }
  | { action: "declared-not-linked"; declared: string; candidates: string[] }
  | { action: "unknown" };

function uniqueNonEmpty(ids: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const v = typeof id === "string" ? id.trim() : "";
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** O VALOR CRU de um `taskId` vira declaração, ou não vira nada. Ponte ÚNICA
 * entre "o que estava no payload" e "o que o servidor considera declarado":
 * `declaredTaskIdFromReportBody` (o objeto já parseado, caminho de ESCRITA) e
 * a extração `json_extract(report_json, '$.taskId')` dos statements de
 * leitura (store.ts) passam os dois por AQUI. Sem isto, "declarado" teria
 * duas definições no repo — e foi a divergência entre duas resoluções da
 * mesma pergunta que produziu a task 4fee76d5.
 *
 * Só `string` não-vazia (aparada) declara. Número, booleano, objeto e
 * ausência caem em `undefined`: `undefined` é "não declarou", nunca "declarou
 * algo inválido" — quem tem um id assim não tem id. */
export function normalizeDeclaredTaskId(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** O `taskId` que o agente escreveu no corpo do report, se houver. Aceita o
 * objeto cru; um report que não é objeto não declara nada. */
export function declaredTaskIdFromReportBody(report: unknown): string | undefined {
  if (report === null || typeof report !== "object" || Array.isArray(report)) return undefined;
  return normalizeDeclaredTaskId((report as Record<string, unknown>).taskId);
}

export function decideReportTaskLink(input: {
  /** `taskId` declarado no corpo do report (a convenção do board). */
  declaredTaskId?: string | null;
  /** Ids das tasks cujo principal (`tasks.card_id`) é este card. */
  principalTaskIds: readonly (string | null | undefined)[];
  /** Ids das tasks com vínculo vivo em `task_cards` para este card. */
  linkTaskIds: readonly (string | null | undefined)[];
}): ReportTaskLink {
  const principals = uniqueNonEmpty(input.principalTaskIds);
  const links = uniqueNonEmpty(input.linkTaskIds);
  // O conjunto de vínculos VIVOS deste card, sem repetir (uma task pode ser
  // principal E ter linha em `task_cards` — é o caso normal).
  const live = uniqueNonEmpty([...principals, ...links]);

  const declared = typeof input.declaredTaskId === "string" ? input.declaredTaskId.trim() : "";
  if (declared) {
    if (live.includes(declared)) return { action: "resolve", taskId: declared, source: "declared" };
    return { action: "declared-not-linked", declared, candidates: live };
  }

  if (principals.length === 1) return { action: "resolve", taskId: principals[0]!, source: "principal" };
  if (principals.length > 1) return { action: "ambiguous", candidates: principals };

  if (links.length === 1) return { action: "resolve", taskId: links[0]!, source: "link" };
  if (links.length > 1) return { action: "ambiguous", candidates: links };

  return { action: "unknown" };
}

/** AGENT-FACING — DO NOT TRANSLATE. Ambiguidade NOMEIA as candidatas: o
 * agente escolhe, o servidor nunca escolhe por ele. Não fundir esta frase
 * com a de `declared-not-linked` — são causas diferentes. */
export function describeAmbiguousTaskRefusal(candidates: readonly string[]): string {
  return (
    `[de: stellar] report recusado: este card está ligado a ${candidates.length} tasks ativas ao mesmo tempo ` +
    `(${candidates.join(", ")}) e não dá para saber de qual delas é este relatório. ` +
    `Diga qual, escrevendo "taskId" DENTRO do objeto do report (ex.: {"ok":true,"taskId":"${candidates[0]}"}), ` +
    `e chame de novo no mesmo turno. Nada foi gravado — adivinhar aqui seria assinar a task errada.`
  );
}

/** AGENT-FACING — DO NOT TRANSLATE. Declarado que não é vínculo vivo: recusa
 * em vez de cair para outro vínculo, que responderia sobre outra task. */
export function describeDeclaredTaskNotLinkedRefusal(declared: string, candidates: readonly string[]): string {
  const list = candidates.length > 0 ? `Os vínculos ativos deste card são: ${candidates.join(", ")}.` : "Este card não tem vínculo ativo nenhum.";
  return (
    `[de: stellar] report recusado: o relatório declara taskId "${declared}", que NÃO é um vínculo ativo deste card. ` +
    `${list} Corrija o taskId e chame de novo no mesmo turno. Nada foi gravado.`
  );
}
