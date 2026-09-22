/**
 * O QUE ACONTECE COM A LINHA DO CARD QUANDO ELE FECHA (task 4e4ec327).
 *
 * MEDIDO no banco vivo antes de escrever isto (2026-09-22):
 *   - fechar um card que NÃO é `chat` APAGAVA a linha (`store:delete` →
 *     `store.deleteCard`): 236 ids que passaram por `spawns` não existem mais em
 *     `cards` (o board tem 32 cards vivos);
 *   - o que NÃO morre com a linha: 423 `reports`, 339 `task_cards`, 181
 *     `tasks.card_id` e 1750 `task_verdicts` continuam apontando para esses
 *     cards mortos — órfãos que a UI não consegue mais nomear;
 *   - `spawns` SOBREVIVE e não guarda `label`: o NOME do card morre com a linha,
 *     e é por isso que reconstruir um handoff hoje é ler `reason`;
 *   - `archived_at`/`archiveCard` já existem e já são usados (só `chat`, item
 *     30), e `listCards`/`listAll` já filtram `archived_at IS NULL` — arquivar é
 *     uma linha que sai do BOARD sem virar lixo visível nele.
 *
 * A decisão vive aqui, e não espalhada no handler de fechamento, pelo mesmo
 * motivo que `mask-buffer.ts`/`connector-label-throttle.ts`: lógica pura tem
 * teste direto, sem precisar de um round-trip CDP inteiro para provar.
 */

export type CardCloseAction = "archive" | "delete";

export type CardCloseDecision = {
  action: CardCloseAction;
  /** Por que ESTA ação — a frase que o registro de fechamento pode citar. */
  why: string;
};

export type CardCloseInput = {
  kind: string;
  /**
   * `true` SÓ quando alguém pediu exclusão de verdade (o `delete_card` do MCP,
   * ou a ação explícita do dono numa lista de arquivados). O gesto de FECHAR
   * nunca é um pedido de exclusão.
   */
  explicitDelete?: boolean;
};

/**
 * A POLÍTICA: o GESTO de fechar preserva a linha; só um PEDIDO EXPLÍCITO apaga.
 *
 * A linha do card é barata (uma linha de `cards`; cabem dezenas de milhares no
 * banco de 9,2 MB que já existe) e é ela que carrega as três coisas que os
 * sobreviventes PRECISAM para não virar órfão anônimo: `label` (como o humano
 * chama o card), `kind`/`provider` (o que ele era) e o vínculo com o board. O
 * gesto de fechar, por si só, não é um pedido de destruição de nada.
 *
 * O que este módulo NÃO decide, de propósito: se a TELA daquele card fica
 * guardada. Hoje o scrollback só existe no xterm do renderer (main não consegue
 * ler: `index.ts` → `onReadCardRequest`) e morre com o card — persistir isso é
 * decisão de armazenamento separada, com custo e sensibilidade próprios.
 */
export function decideCardClose(input: CardCloseInput): CardCloseDecision {
  if (input.explicitDelete) {
    return {
      action: "delete",
      why: `${input.kind}: exclusão PEDIDA (delete_card / ação explícita) — é a única porta que apaga a linha.`,
    };
  }
  return {
    action: "archive",
    why: `${input.kind}: o fecho preserva a linha (é ela que carrega label/kind/board e sustenta reports, task_cards e veredictos); o card sai do board por listCards filtrar archived_at.`,
  };
}
