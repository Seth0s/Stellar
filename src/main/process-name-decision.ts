/**
 * NOME DE PROCESSO POR AGENTE — o esquema que faz o monitor de processos
 * (htop/btop/ps/GNOME) parar de mostrar uma pilha genérica (`stellar`,
 * `node-22`, `agy` aninhados) e passar a agrupar POR TIPO de agente
 * (task 817daa3e).
 *
 * O problema medido: o processo do shim/stub é o NOSSO, mas herda nome genérico
 * — `node` (fallback node do `resources/bin/stellar-mcp`) ou `stellar-mcp-rel`
 * (relay Rust). Quem lê a árvore não consegue dizer a qual provider aquele
 * pedaço pertence. Este módulo é a ÚNICA fonte da regra de nome; o shim (JS) e
 * o relay (Rust) só APLICAM o valor que `pty-registry.ts` injeta em
 * `AGENT_CANVAS_PROC_NAME` — nenhum deles recalcula, então não há duas regras
 * para divergir.
 *
 * O TETO DE 15 CHARS (Linux): o `comm` do processo é `TASK_COMM_LEN` = 16 bytes
 * com o NUL, ou seja **15 caracteres**. `prctl(PR_SET_NAME)` (Rust) e
 * `process.title` (Node) truncam nesse teto; o `cmdline`/argv NÃO tem teto.
 * Medido nesta máquina (auto-teste): `process.title = "stellar:commandcode/2"`
 * → `comm` = `stellar:command` (15) e `cmdline` = o título inteiro.
 *
 * POR QUE O CARD NÃO CABE NO `comm`: `antigravity`/`commandcode` já ocupam 11
 * chars; com o prefixo `st:` (3) sobra 1. Provider + card juntos estouram 15.
 * A escolha foi manter o PROVIDER legível e COMPLETO no `comm` (é o que o
 * monitor mostra e o que permite agrupar por TIPO) e deixar o CARD fora do
 * nome — ele continua legível em `/proc/<pid>/environ` (AGENT_CANVAS_CARD_ID)
 * e na própria árvore (o pai é a CLI daquele card). Se um dia o card PRECISAR
 * aparecer no nome, o caminho é um token curto de provider (ex.: `cc`) — fica
 * registrado aqui como a alternativa, não como o padrão.
 *
 * `st:` (Stellar) e não `stellar:`: o prefixo longo come 8 chars e trunca
 * `commandcode`→`stellar:command`, `antigravity`→`stellar:antigra`. Com `st:`
 * TODOS os ids atuais cabem inteiros (`st:commandcode` = 14, `st:antigravity`
 * = 14) — a colisão por truncamento deixa de existir. O teto só "morde" se um
 * provider futuro tiver id > 12 chars; aí o id é truncado em 15 e a tabela de
 * tokens volta a ser necessária.
 */

/** Prefixo do NOSSO processo. Curto de propósito — ver o doc acima. */
export const AGENT_PROC_PREFIX = "st:";

/** `TASK_COMM_LEN` no Linux é 16 (15 chars + NUL): teto do `comm`. */
export const LINUX_COMM_MAX = 15;

/** Normaliza um pedaço de nome: minúsculas, só `[a-z0-9-]`, nunca vazio.
 * Determinístico para o mesmo provider — o agrupamento por prefixo depende
 * disso. */
export function sanitizeNameToken(raw: string | null | undefined): string {
  const token = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  return token.length > 0 ? token : "unknown";
}

/**
 * O valor que vai para `comm` (e, no shim node, também para o argv0 via
 * `process.title`): `st:<provider>`, truncado no teto de 15. É a CHAVE DE
 * AGRUPAMENTO — dois processos do mesmo provider têm o mesmo nome; providers
 * diferentes, nomes diferentes.
 */
export function agentProcessName(providerId: string | null | undefined): string {
  const name = `${AGENT_PROC_PREFIX}${sanitizeNameToken(providerId)}`;
  return name.length <= LINUX_COMM_MAX ? name : name.slice(0, LINUX_COMM_MAX);
}
