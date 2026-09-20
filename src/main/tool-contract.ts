/**
 * TOOL CONTRACT — a declaração ÚNICA da forma de entrada de uma tool MCP:
 * o que é obrigatório, o que é opcional, o que cada campo aceita, e a frase
 * com que uma recusa volta para o modelo.
 *
 * NÃO CONFUNDIR com `task-contract-decision.ts` — aquele é o contrato de uma
 * TASK (prompt · purpose · deps · review · reportSchema). Este aqui é o
 * contrato de ENTRADA de uma tool: campos de uma chamada.
 *
 * ------------------------- POR QUE DERIVA DO ZOD -------------------------
 * Medido no SDK que este repo embarca (`@modelcontextprotocol/sdk`,
 * `server/mcp.js`): o schema PUBLICADO ao cliente e o schema VALIDADO são o
 * MESMO objeto — `toJsonSchemaCompat(inputSchema)` (mcp.js:75-78) e
 * `safeParseAsync(inputSchema, args)` (mcp.js:172-174) — e o parse roda
 * ANTES do handler. Provado na sonda: com um campo obrigatório ausente, o
 * `handleRequest` stub nunca recebeu a chamada.
 *
 * Consequência que decide o desenho: substituir o zod por um validador
 * próprio significaria apagar `required` do schema publicado de 41 tools —
 * exatamente a divergência schema×validador que a 64aed52b combateu no
 * `providers.json`. Então este módulo NÃO substitui o zod: ele declara a
 * forma num lugar só e GERA o objeto zod dela. O zod continua sendo a
 * verdade publicada, e o teste anti-drift
 * (`tests/unit/tool-contract-anti-drift.test.ts`) percorre o schema
 * publicado conferindo que o conjunto de obrigatórios bate com o declarado.
 *
 * ---------------------- O QUE O CONTRATO NÃO É DONO ----------------------
 * (Declarado aqui de propósito, com a prova, para ninguém "consertar"
 * depois caindo na regressão acima.)
 *
 * A MENSAGEM de um campo ESTATICAMENTE obrigatório e ausente continua sendo
 * a do zod — ele recusa primeiro e o handler nunca roda. Isso é aceitável
 * porque a mensagem dele já nomeia o campo e o que chegou:
 *
 *   `Invalid input: expected string, received undefined at target`
 *
 * O que este módulo faz dono é o que o zod não consegue expressar:
 *   - a OBRIGATORIEDADE num lugar só (mudar `required` aqui muda o schema
 *     publicado, porque o shape é gerado);
 *   - o TEXTO ACEITO por campo (`accepted`), usado em toda recusa;
 *   - o conjunto obrigatório DINÂMICO (o `reportSchema` de uma task, que
 *     depende da chamada e não do tool);
 *   - a FORMA da recusa como RESULTADO da mesma chamada, no idioma
 *     agent-facing do repo — o gate de veredito já usa essa forma.
 *
 * REGRA x FORMA: este módulo responde "este campo veio, com a forma
 * aceita?" — nunca "quem pode julgar" (`judgment-write-decision`), nem
 * "este provider honra effort" (`spawn-profile-decision`). As predicações
 * de conteúdo são INJETADAS pelo chamador (ver `decideDeclaredKeys`), para
 * este módulo não reimplementar `emptyReportSchemaFields` nem ninguém.
 */

import * as z from "zod";

/**
 * Um campo da entrada de uma tool. `required` é declarado AQUI e só aqui —
 * o `inputSchema` publicado é derivado (ver `buildToolInputSchema`).
 */
export type ToolFieldDecl = {
  /** Nome do campo como o agente o envia (`boardId`, `report`, ...). */
  readonly name: string;
  /** A forma aceita, como schema zod — é dela que sai o tipo publicado. */
  readonly schema: z.ZodType;
  /** Obrigatório. Ausente = opcional. */
  readonly required?: boolean;
  /**
   * AGENT-FACING — DO NOT TRANSLATE (o campo; o texto abaixo é pt-BR porque
   * o leitor é o modelo no meio do turno, como nas recusas de
   * `judgment-write-decision`). O que este campo aceita, em palavras: é a
   * parte "must be ..." da frase de recusa.
   */
  readonly accepted: string;
};

export type ToolContractDecl = {
  /** Nome da tool, como aparece na recusa. */
  readonly tool: string;
  readonly fields: readonly ToolFieldDecl[];
};

/**
 * O `inputSchema` da tool, GERADO da declaração: obrigatório vira
 * não-opcional, opcional vira `.optional()`, e o objeto é ESTRITO.
 *
 * Estrito de propósito: o zod DESCARTA chave desconhecida em silêncio.
 * Medido na sonda — `list_tasks({boardid: "118"})`, typo de `boardId`,
 * devolveu `{"ok":true,"echoed":{"cmd":"list_tasks"}}`: sem erro, com a
 * chave jogada fora, respondendo TODOS os boards em vez do pedido. Um typo
 * virava resposta errada sem sinal nenhum. Estrito, o mesmo typo vira
 * `Unrecognized key: "boardid"` — resultado da mesma chamada, handler nunca
 * roda, e o schema publicado ainda ganha `additionalProperties: false`
 * (medido: `required` continua publicado, não se perde nada).
 */
export function buildToolInputSchema(decl: ToolContractDecl) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of decl.fields) {
    shape[field.name] = field.required ? field.schema : field.schema.optional();
  }
  return z.object(shape).strict();
}

/** Os campos que a declaração diz serem obrigatórios — o lado declarado do
 * invariante que o teste anti-drift confronta com o schema publicado. */
export function declaredRequiredFields(decl: ToolContractDecl): string[] {
  return decl.fields.filter((field) => field.required).map((field) => field.name);
}

/**
 * Como o valor RECEBIDO aparece na frase. Uma recusa que não mostra o
 * recebido obriga o agente a adivinhar o que ele mandou.
 *
 * Mesma ideia do `describeValue` de `providers-dynamic.ts`, em pt-BR porque
 * o leitor é outro: lá é o humano lendo `providers.json` no editor, aqui é
 * o modelo no meio do turno. Unificar as duas num só lugar é uma fatia
 * própria (mover a de lá para um módulo compartilhado), não esta.
 */
export function describeReceived(value: unknown): string {
  if (value === undefined) return "ausente";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length <= 4 ? JSON.stringify(value) : `uma lista de ${value.length} itens`;
  }
  if (typeof value === "string") return value.length <= 120 ? `"${value}"` : `uma string de ${value.length} caracteres`;
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "object") return "um objeto";
  return typeof value;
}

/**
 * A FRASE DE UMA RECUSA — a única fábrica de mensagem deste módulo, com as
 * três coisas que a tornam acionável: o CAMPO, o que ele ACEITA e o que
 * CHEGOU. Mesma estrutura da `refusal()` da 64aed52b (campo + accepted +
 * got), no idioma agent-facing do repo.
 */
export function fieldRefusal(input: {
  tool: string;
  field: string;
  accepted: string;
  got: unknown;
}): string {
  return (
    `[de: stellar] ${input.tool} recusado: \`${input.field}\` deve ser ${input.accepted} — ` +
    `recebido: ${describeReceived(input.got)}. ` +
    `Corrija este campo e chame de novo no mesmo turno; nada foi gravado.`
  );
}

export type DeclaredKeysDecision = { action: "ok" } | { action: "refuse"; error: string };

/**
 * O conjunto obrigatório DINÂMICO de uma chamada — o caso que o zod não
 * alcança, porque as chaves exigidas vêm da TASK (`reportSchema`), não do
 * tool, e mudam a cada chamada.
 *
 * A FORMA é deste módulo; a PREDIÇÃO de "esta chave tem conteúdo real?" é
 * INJETADA pelo chamador (`isEmpty`), que passa a que já existe no repo
 * (`emptyReportSchemaFields`) em vez de uma segunda cópia da mesma regra.
 *
 * Quando o conjunto aplicável é vazio, é `ok` — ausência de exigência não é
 * uma exigência vazia.
 */
export function decideDeclaredKeys(input: {
  tool: string;
  /** Onde as chaves moram, para a frase ("as chaves do reportSchema da task X"). */
  declaredBy: string;
  /** O que cada chave precisa ter, em palavras. */
  accepted: string;
  /** As chaves exigidas nesta chamada (a task pode não declarar nenhuma). */
  declared: readonly string[] | null | undefined;
  /** O payload que deveria conter as chaves. */
  provided: unknown;
  /** Injeta "quais destas chaves estão ausentes ou vazias". */
  offendingKeys: (declared: readonly string[], provided: unknown) => string[];
}): DeclaredKeysDecision {
  if (!input.declared || input.declared.length === 0) return { action: "ok" };
  const offending = input.offendingKeys(input.declared, input.provided);
  if (offending.length === 0) return { action: "ok" };
  const keys = offending.map((key) => `\`${key}\``).join(", ");
  return {
    action: "refuse",
    error:
      `[de: stellar] ${input.tool} recusado: ${input.declaredBy} exige ${keys} com ${input.accepted} — ` +
      `recebido: ${offending.map((key) => `${key} ${describeReceived(readKey(input.provided, key))}`).join(", ")}. ` +
      `Preencha com a evidência MEDIDA e chame de novo no mesmo turno; nada foi gravado.`,
  };
}

function readKey(container: unknown, key: string): unknown {
  if (container === null || typeof container !== "object" || Array.isArray(container)) return undefined;
  return (container as Record<string, unknown>)[key];
}
