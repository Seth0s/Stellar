/**
 * APAGAR DE VERDADE: UM CORPO SÓ (task d3c005dc).
 *
 * Duas portas apagam card:
 *   - a do AGENTE: `delete_card` no message-bus (para um card fora do board
 *     carregado, com a autorização que aquele caminho exige);
 *   - a da UI: `store:delete`, o gesto explícito do dono.
 * Até esta task elas apagavam CONJUNTOS DIFERENTES: só a do agente levava os
 * conectores, e a da UI deixava o conector apontando para um card inexistente
 * — MEDIDO no board do dono, 2 órfãos. Duas portas para a mesma ação só são
 * aceitáveis se o efeito for o mesmo; a partir daqui as duas chamam esta
 * função, então não há como divergirem de novo.
 *
 * O conjunto, e por que cada parte:
 *   - `deleteConnectorsForCard`: a aresta (`spawned`, `depends`, …) morre com
 *     o card que a criou — `report-notify-routing.ts` documenta que é ela que
 *     faz o roteamento do relatório parar de procurar um card que sumiu;
 *   - `deleteCard`: a linha de `cards`, o `card_traces` do fecho (exclusão de
 *     verdade leva o rastro, senão "excluir" vira mentira com o texto do dono
 *     dentro) e a marca de orquestrador, quando era dele.
 * Tasks e reports NÃO entram: são identidade separada, e o vínculo deles com
 * o card é histórico — `tasks.card_id` sobrevive ao DELETE de `cards` de
 * propósito (é assim que a Fila mostra card órfão).
 *
 * Existe como módulo, e não inline no `index.ts`, por um motivo de teste: o
 * `index.ts` é a entrada do Electron (importá-lo num teste sobe o app), então
 * uma composição que mora lá dentro não tem como ser exercitada. Aqui o teste
 * usa um store REAL e prova o conjunto inteiro.
 */
type CardDeleter = {
  deleteConnectorsForCard: (cardId: string) => unknown;
  deleteCard: (cardId: string) => unknown;
};

export function deleteCardForever(store: CardDeleter, cardId: string): void {
  store.deleteConnectorsForCard(cardId);
  store.deleteCard(cardId);
}
