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
  /**
   * O campo é o PAYLOAD de forma livre desta tool (`report.report`,
   * `update_task.result`): forma declarada `z.unknown()`, conteúdo por conta
   * do chamador. Só um campo assim pode esconder um campo de CHAMADA dentro
   * de si — ver `decideMisplacedCallFields`.
   */
  readonly freeForm?: boolean;
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
    `[de: stellar] ${input.tool} refused: \`${input.field}\` must be ${input.accepted} — ` +
    `received: ${describeReceived(input.got)}. ` +
    `Fix this field and call again in the same turn; nothing was written.`
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
      `[de: stellar] ${input.tool} refused: ${input.declaredBy} requires ${keys} with ${input.accepted} — ` +
      `received: ${offending.map((key) => `${key} ${describeReceived(readKey(input.provided, key))}`).join(", ")}. ` +
      `Fill it with the MEASURED evidence and call again in the same turn; nothing was written.`,
  };
}

function readKey(container: unknown, key: string): unknown {
  if (container === null || typeof container !== "object" || Array.isArray(container)) return undefined;
  return (container as Record<string, unknown>)[key];
}

/**
 * --------------- CAMPO DE CHAMADA ESCRITO DENTRO DO PAYLOAD ---------------
 * Medido 2026-09-20 neste board (task a477f3d4): o card revisor 97924132
 * chamou `report` com `verdict` DENTRO do objeto de payload, em vez do campo
 * `verdict` da chamada. A tool respondeu `ok: true`, o report entrou
 * (`reports` seq 515, canal http), `reports.verdict` ficou NULL e a task
 * seguiu `running`. O revisor só percebeu no relatório seguinte e gastou uma
 * rodada INTEIRA reemitindo o mesmo veredito (seq 519, que narra o caso por
 * escrito: "o campo verdict foi embutido dentro do payload em vez de viajar
 * no campo próprio da chamada — o report foi aceito e o verdict gravou
 * null"). Do lado dele a chamada deu certo: é a MESMA classe de falha que o
 * shape estrito fechou para chave DESCONHECIDA (`list_tasks({boardid})`
 * respondia todos os boards), com uma diferença que decide o desenho — aqui
 * a chave é CONHECIDA, no lugar errado, e o zod não tem como ver isso:
 * `report` é declarado `z.unknown()`, então QUALQUER chave é legítima ali
 * dentro por construção.
 *
 * A REGRA é mecânica e não escreve nome de tool nem de campo à mão: um campo
 * DECLARADO da tool que não é o próprio payload, aparecendo como chave
 * dentro do payload, é um campo de CHAMADA no lugar errado — a tool o lê da
 * CHAMADA, nunca de dentro do payload, então ali dentro ele não é lido.
 *
 * Duas precisões deliberadas, cada uma medida:
 *
 *   - Recusa só quando o campo da chamada está AUSENTE. Com os dois
 *     presentes (`{report:{verdict:"aprovado"}, verdict:"aprovado"}`) nada se
 *     perde: o explícito vence e o embutido é removido do payload
 *     (`promoteReportVerdict`). Recusar aí seria recusa gratuita num caminho
 *     que funciona.
 *   - `key === payloadField.name` não conta: um payload com a chave `report`
 *     dentro de si é o aninhamento do próprio campo, ambíguo com prosa
 *     livre, não um campo de chamada deslocado.
 *
 * POR QUE ESTA PORTA: o `verdict` embutido é um caminho SUPORTADO do
 * acbridge (`report <json>` tem UM argumento — ver `report-verdict-decision.ts`),
 * e é o bus que o promove; lá a chave é o único jeito de nomear o campo
 * tipado que o CLI não tem. No MCP o campo tipado EXISTE na chamada, então
 * ali o mesmo key é erro de quem chamou — e é ali que a recusa ensina sem
 * tirar nada de ninguém.
 *
 * LIMITE DECLARADO: a varredura só enxerga payload OBJETO, ou string que
 * decodifica para objeto (`decode`). No seq 515 medido o envelope veio como
 * string de JSON MALFORMADA (10cf58d0 — `decodeReportArgument` desiste e
 * passa a string adiante): os dois defeitos coincidiram e a chave embutida
 * ficou invisível para esta função. Fechar o envelope é a outra task; esta
 * fecha a metade "chave conhecida no lugar errado".
 */
export type MisplacedCallField = {
  /** O campo da CHAMADA que apareceu dentro do payload. */
  readonly field: string;
  /** O campo de payload onde ele foi encontrado. */
  readonly payloadField: string;
  /** O valor que veio no lugar errado (para a recusa mostrar o recebido). */
  readonly got: unknown;
};

/** A varredura pura. Vazia = nada deslocado; nunca lança. */
export function misplacedCallFields(input: {
  contract: ToolContractDecl;
  args: Record<string, unknown>;
  /** Decodifica um payload entregue como string (`decodeReportArgument`). */
  decode?: (raw: unknown) => unknown;
}): MisplacedCallField[] {
  const payloads = input.contract.fields.filter((field) => field.freeForm);
  // Tool sem payload de forma livre não tem onde esconder campo de chamada.
  if (payloads.length === 0) return [];
  const declared = new Set(input.contract.fields.map((field) => field.name));
  const found: MisplacedCallField[] = [];
  for (const payload of payloads) {
    const raw = input.args[payload.name];
    const value = input.decode ? input.decode(raw) : raw;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === payload.name) continue;
      if (!declared.has(key)) continue;
      // Já veio como campo da chamada: o explícito vence e o valor não se
      // perde — ver o cabeçalho.
      if (input.args[key] !== undefined) continue;
      found.push({ field: key, payloadField: payload.name, got: inner });
    }
  }
  return found;
}

/**
 * A recusa — nomeia as três coisas que a tornam acionável no mesmo turno:
 * O QUE veio (`verdict`), ONDE veio (dentro do payload `report`, com o valor
 * recebido) e ONDE vai (como campo próprio da chamada, com o que ele aceita).
 */
export function decideMisplacedCallFields(input: {
  contract: ToolContractDecl;
  args: Record<string, unknown>;
  decode?: (raw: unknown) => unknown;
}): DeclaredKeysDecision {
  const found = misplacedCallFields(input);
  if (found.length === 0) return { action: "ok" };
  const acceptedOf = (name: string) => input.contract.fields.find((field) => field.name === name)?.accepted ?? "the declared form for this field";
  const parts = found.map(
    (item) =>
      `\`${item.field}\` came INSIDE the payload \`${item.payloadField}\` (received: ${describeReceived(item.got)}; as a call field it accepts ${acceptedOf(item.field)})`,
  );
  return {
    action: "refuse",
    error:
      `[de: stellar] ${input.contract.tool} refused: ${parts.join("; ")}. ` +
      `Those names are fields of the CALL, not payload content — inside it they are not read, and the value would be lost in silence. ` +
      `Send each one as its own field of the call, next to \`${found[0]!.payloadField}\`, and leave only the content in the payload. ` +
      `Fix it and call again in the same turn; nothing was written.`,
  };
}
