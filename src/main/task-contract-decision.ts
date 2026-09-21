/**
 * Task CONTRACT — judgment the app cannot derive (DESIGN-BACKLOG §0).
 *
 * Territory, gates, allowCommit, and reportSchema are declared once on the
 * task as structured fields. Consumer: the delivered brief text, and (for
 * reportSchema) in-line `report` refusal that names the missing field.
 *
 * NOT the same class as execution profile (provider/model/effort on
 * `task_cards`). Criterion is the CONSUMER: contract → brief / report
 * acceptance; profile → spawn argv / participation audit. Keep them apart.
 *
 * Absence of every field is NORMAL. Never invent territory by watching
 * the filesystem, never intercept `git add`, never judge gate output.
 */

export type TaskContract = {
  /** Paths / globs the agent may touch. Empty/absent = undeclared. */
  territory: string[] | null;
  /** Commands the agent must run before declaring success. */
  gates: string[] | null;
  /** false = do not commit. null = undeclared (not "allowed"). */
  allowCommit: boolean | null;
  /** Top-level keys required on an accepted (non-failure) report. */
  reportSchema: string[] | null;
};

export type TaskContractInput = {
  territory?: unknown;
  gates?: unknown;
  allowCommit?: unknown;
  reportSchema?: unknown;
};

export type TaskContractParse =
  | { ok: true; contract: TaskContract }
  | { ok: false; field: string; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Non-empty trimmed strings only; duplicates kept in order (declaration is evidence). */
export function normalizeStringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (trimmed.length === 0) return null;
    out.push(trimmed);
  }
  return out.length === 0 ? null : out;
}

export function normalizeAllowCommit(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") return null;
  return value;
}

/**
 * Parse wire fields for create_task / update_task. Unknown shapes are
 * refused (same teaching style as purpose / effort) — never silently
 * dropped to null when the caller sent a value.
 */
export function parseTaskContractInput(input: TaskContractInput): TaskContractParse {
  const contract: TaskContract = {
    territory: null,
    gates: null,
    allowCommit: null,
    reportSchema: null,
  };

  if ("territory" in input && input.territory !== undefined) {
    if (input.territory === null) {
      contract.territory = null;
    } else {
      const list = normalizeStringList(input.territory);
      if (list === null && input.territory !== null) {
        return {
          ok: false,
          field: "territory",
          error: 'territory must be an array of non-empty strings (or omitted/null), got a value that is not',
        };
      }
      contract.territory = list;
    }
  }

  if ("gates" in input && input.gates !== undefined) {
    if (input.gates === null) {
      contract.gates = null;
    } else {
      const list = normalizeStringList(input.gates);
      if (list === null && input.gates !== null) {
        return {
          ok: false,
          field: "gates",
          error: 'gates must be an array of non-empty strings (or omitted/null), got a value that is not',
        };
      }
      contract.gates = list;
    }
  }

  if ("allowCommit" in input && input.allowCommit !== undefined) {
    if (input.allowCommit === null) {
      contract.allowCommit = null;
    } else {
      const flag = normalizeAllowCommit(input.allowCommit);
      if (flag === null) {
        return {
          ok: false,
          field: "allowCommit",
          error: "allowCommit must be a boolean (or omitted/null)",
        };
      }
      contract.allowCommit = flag;
    }
  }

  if ("reportSchema" in input && input.reportSchema !== undefined) {
    if (input.reportSchema === null) {
      contract.reportSchema = null;
    } else {
      const list = normalizeStringList(input.reportSchema);
      if (list === null && input.reportSchema !== null) {
        return {
          ok: false,
          field: "reportSchema",
          error: 'reportSchema must be an array of non-empty strings (or omitted/null), got a value that is not',
        };
      }
      contract.reportSchema = list;
    }
  }

  return { ok: true, contract };
}

/** Persist helpers — SQL TEXT / INTEGER NULL. */
export function territoryToSql(list: string[] | null | undefined): string | null {
  return list && list.length > 0 ? JSON.stringify(list) : null;
}

export function gatesToSql(list: string[] | null | undefined): string | null {
  return list && list.length > 0 ? JSON.stringify(list) : null;
}

export function reportSchemaToSql(list: string[] | null | undefined): string | null {
  return list && list.length > 0 ? JSON.stringify(list) : null;
}

export function allowCommitToSql(flag: boolean | null | undefined): number | null {
  if (flag === true) return 1;
  if (flag === false) return 0;
  return null;
}

export function territoryFromSql(json: string | null | undefined): string[] | null {
  return normalizeStringList(safeParseJson(json));
}

export function gatesFromSql(json: string | null | undefined): string[] | null {
  return normalizeStringList(safeParseJson(json));
}

export function reportSchemaFromSql(json: string | null | undefined): string[] | null {
  return normalizeStringList(safeParseJson(json));
}

export function allowCommitFromSql(value: number | null | undefined): boolean | null {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function safeParseJson(json: string | null | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export function contractFromTaskRow(row: {
  territory_json?: string | null;
  gates_json?: string | null;
  allow_commit?: number | null;
  report_schema_json?: string | null;
}): TaskContract {
  return {
    territory: territoryFromSql(row.territory_json),
    gates: gatesFromSql(row.gates_json),
    allowCommit: allowCommitFromSql(row.allow_commit),
    reportSchema: reportSchemaFromSql(row.report_schema_json),
  };
}

export function contractHasAny(contract: TaskContract): boolean {
  return (
    (contract.territory !== null && contract.territory.length > 0) ||
    (contract.gates !== null && contract.gates.length > 0) ||
    contract.allowCommit !== null ||
    (contract.reportSchema !== null && contract.reportSchema.length > 0)
  );
}

/**
 * Append a structured contract block to a delivered brief. Declared fields
 * only — never invents. Empty contract leaves the brief untouched.
 */
export function appendTaskContract(brief: string | undefined, contract: TaskContract): string | undefined {
  if (!contractHasAny(contract)) return brief;
  const lines: string[] = ["[stellar:contract]"];
  if (contract.territory && contract.territory.length > 0) {
    lines.push("territory:");
    for (const path of contract.territory) lines.push(`- ${path}`);
  }
  if (contract.gates && contract.gates.length > 0) {
    lines.push("gates:");
    for (const gate of contract.gates) lines.push(`- ${gate}`);
  }
  if (contract.allowCommit !== null) {
    lines.push(`allowCommit: ${contract.allowCommit ? "true" : "false"}`);
  }
  if (contract.reportSchema && contract.reportSchema.length > 0) {
    lines.push("reportSchema:");
    for (const field of contract.reportSchema) lines.push(`- ${field}`);
  }
  const block = lines.join("\n");
  const base = typeof brief === "string" ? brief.trimEnd() : "";
  return base.length > 0 ? `${base}\n\n${block}` : block;
}

/* ============ AUTORIA DE `gates` (decisão do dono, 2026-09-21) ============
 *
 * `gates` são comandos que o APP RODA (`gate-runner.ts`). A porta MCP aceita
 * `gates` de QUALQUER card — medido no banco real: 171 tasks com gates, 6
 * cards distintos autorando, 38 delas no board 118 criadas por cards que NÃO
 * são o orquestrador. Não havia autorização nenhuma, só validação de FORMA.
 *
 * A regra, e a razão da sua FORMA:
 *   - board COM marca (`boards.orchestrator_card_id`) → só o card marcado
 *     declara gates; qualquer outro é RECUSADO nomeando o campo;
 *   - board SEM marca → comportamento de hoje (aceita) e REGISTRA. Medido:
 *     os boards 64 (Maestro) e 97924025 (Estudos) estão com a marca NULL —
 *     uma regra incondicional os brickaria, que é o defeito que isto evita.
 *
 * O gatilho é a MUDANÇA do conjunto, não o valor: LIMPAR os gates é tanta
 * autoria quanto escrevê-los (um implementador que apaga os próprios gates
 * escapa da verificação), então `null`/`[]` sobre um conjunto existente
 * também é recusado. Escrever o MESMO conjunto não é autoria — não muda o que
 * roda, e recusar aí só criaria atrito.
 *
 * A leitura do papel é ESCOPADA à task quando o chamador precisar de papel
 * (`getTaskCards(taskId)`); esta função não lê nada — recebe a marca.
 */

/** Igualdade de conjunto ORDENADA: ordem é execução (mudar a ordem muda o
 * que roda e em que ordem), então uma permutação é um conjunto novo. */
function sameGateSet(a: readonly string[] | null, b: readonly string[] | null): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((gate, i) => gate === right[i]);
}

export type GatesAuthorshipDecision =
  | { action: "allow" }
  | { action: "allow-and-record"; note: string }
  | { action: "refuse"; error: string };

export function decideGatesAuthorship(input: {
  tool?: string;
  /** Conjunto que a chamada quer gravar (já normalizado pelo parse do contrato). */
  gates: string[] | null | undefined;
  /** Conjunto que a task TEM hoje (`null` no create). */
  current: string[] | null | undefined;
  boardId: string;
  orchestratorCardId: string | null | undefined;
  requesterId: string | null | undefined;
}): GatesAuthorshipDecision {
  if (sameGateSet(input.gates ?? null, input.current ?? null)) return { action: "allow" };
  const mark =
    typeof input.orchestratorCardId === "string" && input.orchestratorCardId.trim().length > 0
      ? input.orchestratorCardId.trim()
      : null;
  if (!mark) {
    return {
      action: "allow-and-record",
      note: describeGatesAuthorshipUndeclaredBoard({
        boardId: input.boardId,
        requesterId: input.requesterId,
      }),
    };
  }
  if (input.requesterId && input.requesterId === mark) return { action: "allow" };
  return {
    action: "refuse",
    error: describeGatesAuthorshipRefusal({
      tool: input.tool,
      gates: input.gates ?? [],
      boardId: input.boardId,
      orchestratorCardId: mark,
      requesterId: input.requesterId ?? null,
    }),
  };
}

export function describeGatesAuthorshipRefusal(input: {
  tool?: string;
  gates: readonly string[];
  boardId: string;
  orchestratorCardId: string;
  requesterId: string | null;
}): string {
  const who = input.requesterId ?? "um chamador anônimo (sem requesterId)";
  return (
    `[de: stellar] ${input.tool ?? "create_task/update_task"} recusado: \`gates\` são comandos que o APP RODA, ` +
    `e no board "${input.boardId}" só o card marcado como orquestrador (${input.orchestratorCardId}) os declara — ` +
    `quem chamou foi ${who}. O conjunto mudaria para ${input.gates.length} comando(s), e nada dele foi gravado. ` +
    `Chame do card do orquestrador, ou peça ao humano para marcar um orquestrador no board — ` +
    `se o que você quer é pedir uma mudança, use request_task_status. Nada foi gravado.`
  );
}

/** O registro de um board sem marca: a escrita PASSA (comportamento de hoje,
 * não se brickam 64 e Estudos) e o fato fica dito, em vez de sumir. */
export function describeGatesAuthorshipUndeclaredBoard(input: {
  boardId: string;
  requesterId: string | null | undefined;
}): string {
  const who = input.requesterId ?? "anônimo";
  return (
    `board "${input.boardId}" não tem orquestrador marcado (boards.orchestrator_card_id NULL): ` +
    `\`gates\` escritos por ${who} foram ACEITOS (comportamento de hoje) e REGISTRADOS aqui. ` +
    `Marque um orquestrador no board para que só ele declare gates — sem marca, esta regra não tem a quem recorrer.`
  );
}

/**
 * First required reportSchema key missing from a plain-object report.
 * Presence = own enumerable key (value may be null/false/0). Arrays and
 * non-objects fail the first field (they cannot satisfy a key list).
 */
export function missingReportSchemaField(report: unknown, schema: string[] | null | undefined): string | null {
  if (!schema || schema.length === 0) return null;
  if (!isPlainObject(report)) return schema[0] ?? null;
  for (const field of schema) {
    if (!Object.prototype.hasOwnProperty.call(report, field)) return field;
  }
  return null;
}
