/**
 * Quem pode reescrever o `kind` de um conector.
 *
 * DESIGN-BACKLOG.md §0, review adversarial da frente de roteamento de
 * report (rodada 2, 2026-09-11, achado 1) — antes desta guarda,
 * `set_connector_kind` checava só se o conector existia. Isso era
 * inofensivo enquanto `kind` era de fato decorativo, e deixou de ser no
 * momento em que `spawned` passou a decidir PARA QUEM vai o push de
 * report: qualquer card podia chamar `list_connectors`, achar o conector
 * `spawned` legítimo de outro, desarmá-lo com `set_connector_kind(id,
 * null)` e retitular o próprio — reintroduzindo, por outra porta, o
 * sequestro de notificação que a rodada 1 tinha sido reprovada por
 * permitir. A guarda daquela rodada: uma regra só, sem exceção por kind —
 * só a ponta de ORIGEM mexe no `kind` de um conector, sempre, uniforme.
 *
 * RODADA 2 (review adversarial do card 337, 2026-09-11, "fila 85975417") —
 * a uniformidade acima tinha DOIS custos reais, os dois vindo do mesmo
 * lugar (tratar toda escrita de `kind` como se fosse tão sensível quanto
 * mexer em `spawned`, quando as duas coisas que a guarda original
 * realmente precisa impedir são bem mais estreitas):
 * 1. Um orquestrador A que criou B e C (dono da linhagem `spawned` A→B e
 *    A→C) não conseguia anotar `depends`/`context` no conector B→C — a
 *    origem ali é B, não A —, embora mapear o grafo dos PRÓPRIOS
 *    subordinados seja exatamente o uso que a descrição da tool promete
 *    ("an orchestrating agent attaches them on purpose... for THAT
 *    ORCHESTRATOR'S OWN reading").
 * 2. Um orquestrador externo sem MCP-URL carimbada (Claude Desktop,
 *    qualquer cliente que fale HTTP direto) não tem `requesterId`
 *    nenhum — a exigência de "chamador identificado", pensada pra
 *    fechar o vetor do achado 1, também expulsava por completo quem só
 *    queria anotar `context`/`depends`, que nunca foi o vetor de nada.
 *
 * A pergunta certa não é "quem pode mexer no kind" — é "esta escrita
 * ESPECÍFICA pode mudar quem o app acha que É o spawner de alguém".
 * Só DUAS formas de escrita fazem isso:
 * (a) `desiredKind === "spawned"` — DECLARAR uma linhagem nova (o próprio
 *     mecanismo de hand-off deliberado que `report-notify-routing.ts`
 *     documenta e depende de continuar possível).
 * (b) `connector.currentKind === "spawned"` e a escrita muda/limpa isso —
 *     DESARMAR uma linhagem que já vale hoje (o vetor original do achado
 *     1: `set_connector_kind(id, null)` num `spawned` alheio).
 * Qualquer outra escrita (`context`/`depends`/`null` num conector que já
 * não era `spawned`) é PURAMENTE ADVISORY — nada neste app lê esse valor
 * pra decidir nada (`list_connectors`'s própria descrição: "'depends'/
 * 'context' stay purely advisory... nothing in this app acts on
 * either"; task auto-dispatch "never reads this graph at all"). Fica
 * LIVRE: sem exigir identidade, sem exigir ser a ponta de origem — o
 * mesmo espírito de "list_connectors já devolve todos os conectores a
 * qualquer card, é dado público do canvas" que a MESMA rodada de review
 * já confirmou inofensivo pro vazamento de existência de id.
 *
 * As duas formas (a)/(b) continuam com a MESMA guarda estrita de antes —
 * chamador identificado E é a ponta de ORIGEM — porque são elas, não o
 * `kind` em si, que decidem quem recebe o push de report amanhã.
 *
 * Furo avaliado e não fechado aqui, de propósito (não é o vetor deste
 * achado): a ponta de ORIGEM sempre pôde se auto-declarar `spawned` do
 * PRÓPRIO conector de saída, mesmo sem nunca ter de fato spawnado o
 * destino — verdade antes desta rodada, verdade depois. Não é uma
 * regressão desta mudança: é o mecanismo de hand-off deliberado que
 * `report-notify-routing.ts` documenta como intencional ("quem assume
 * retitula o PRÓPRIO conector até o card supervisionado"), e nenhuma das
 * duas rodadas de guarda aqui jamais tentou verificar a alegação, só
 * quem tem permissão de fazê-la.
 */

export interface ConnectorEndpoints {
  fromCardId: string;
  toCardId: string;
  /** O `kind` ATUAL do conector, antes desta escrita — decide, junto com
   * `desiredKind`, se esta é uma escrita que afeta linhagem `spawned`
   * (guarda estrita) ou uma anotação advisory (livre). `null` é o valor
   * real de "decorativo/sem kind", não ausência de leitura. */
  currentKind: string | null;
}

export type ConnectorKindWriteDecision = { allowed: true } | { allowed: false; error: string };

export function decideConnectorKindWrite(
  requesterId: string | undefined,
  connector: ConnectorEndpoints | undefined,
  desiredKind: string | null,
): ConnectorKindWriteDecision {
  if (!connector) return { allowed: false, error: "no such connector" };

  // Ver o comentário grande acima — só estas duas formas de escrita
  // afetam quem o app acha que É o spawner de alguém. Qualquer outra
  // (context/depends/null num conector que já não era spawned) é
  // advisory pura: livre, sem checar identidade nem origem.
  const affectsSpawnedLineage = desiredKind === "spawned" || connector.currentKind === "spawned";
  if (!affectsSpawnedLineage) return { allowed: true };

  const requester = requesterId?.trim();
  if (!requester) {
    return { allowed: false, error: "changing a connector's 'spawned' lineage requires an identified caller (callerCardId)" };
  }
  if (requester !== connector.fromCardId) {
    return {
      allowed: false,
      error: `only the connector's source card (${connector.fromCardId}) may change its 'spawned' lineage`,
    };
  }
  return { allowed: true };
}
