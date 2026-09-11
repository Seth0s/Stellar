/**
 * Quem É o chamador de uma tool MCP — o carimbo da URL ou o argumento
 * explícito `callerCardId`, e qual dos dois vence.
 *
 * DESIGN-BACKLOG.md §0, review adversarial do card 337 ("fila 85975417",
 * 2026-09-11) — ACHADO CRÍTICO, escalada de privilégio real: a versão
 * anterior de `mcp-server.ts`'s `caller()` era
 * `(explicit && explicit.trim() ? explicit : urlCardId)` — o EXPLÍCITO
 * vencia o carimbo. `requesterId` (o que `caller()` produz) alimenta
 * `getCardBoardId` → `isBoardAutonomous` (message-bus.ts), que é o que
 * decide PULAR o modal de consentimento humano pra `spawn_agent`/
 * `open_url`/`close_card`. Consequência: um card num board comum passava
 * `callerCardId` = id de um card QUALQUER num board autônomo (dado
 * público — `list_cards` devolve todo card do board carregado, e um id de
 * outro board pode ser conhecido por outros meios), o sistema olhava o
 * board da vítima forjada, via que era autônomo, e executava sem
 * aprovação nenhuma. O texto de `spawn_agent`'s própria descrição
 * ("Pass it only to override that") documentava o próprio buraco como se
 * fosse recurso.
 *
 * A ASSIMETRIA que faz a inversão ser o conserto certo, não um dos dois
 * lados arbitrariamente escolhido: `urlCardId` é carimbado UMA VEZ por
 * `pty-registry.ts` no momento do spawn, dentro da configuração do MCP
 * client do PRÓPRIO provedor (`providers.ts`'s `buildArgs`) — fora do
 * alcance do modelo rodando ali dentro. O modelo controla os ARGUMENTOS
 * de uma chamada de tool (incluindo `callerCardId`), nunca a URL que o
 * client MCP do seu próprio host CLI está configurado pra discar. Confiar
 * no carimbo sempre que ele existe fecha o vetor sem exceção: nenhum
 * argumento que o modelo escolha preencher pode mudar quem o servidor
 * acha que ele é.
 *
 * CASO SEM CARIMBO (`urlCardId` ausente) — decisão explícita, não
 * esquecimento: continua caindo pro explícito, exatamente como hoje.
 * Dois caminhos reais batem nisso: um cliente MCP externo genuíno
 * (Claude Desktop, um smoke test discando a porta HTTP direto) nunca tem
 * `?card=` na própria URL — não é um card desta app, não tem processo
 * spawnado, não tem carimbo pra ter. Recusar o explícito também aí
 * expulsaria esse caminho por inteiro (o próprio `connector-kind-
 * authorization.ts`, mesma rodada de review, achado o custo gêmeo:
 * recusar chamador sem identidade também barra esse mesmo cliente). Isto
 * NÃO reabre o vetor do achado: a vulnerabilidade era especificamente "um
 * card COM carimbo real mentindo sobre qual card ele é" — sem carimbo
 * nenhum, o servidor já não tinha (e continua sem ter) uma verdade
 * verificável pra defender; a garantia nova é "quando existe uma verdade
 * verificável, ela sempre vence", não "toda chamada precisa de uma".
 *
 * O QUE ISTO REMOVE, deliberadamente — "um agente que legitimamente fala
 * em nome de outro card" (o comentário original de `CALLER_CARD_ID_FIELD`
 * chamava isso de caso de uso preservado): sob a nova precedência, um
 * card COM carimbo não consegue mais se declarar como outro via
 * `callerCardId` — o carimbo sempre vence. Avaliado e não há sobrevida
 * possível: não existe, em lugar nenhum deste código ou do
 * DESIGN-BACKLOG, uma verificação que distinga "A fala legitimamente por
 * B" de "A finge ser B" — as duas produzem o mesmo argumento
 * (`callerCardId: "B"`). Qualquer regra que aceitasse a alegação SEM
 * verificação teria a mesma forma do próprio achado. Se um caso de uso
 * real de retransmissão surgir no futuro, precisa de uma verificação
 * própria (ex.: conferir uma linhagem de spawn/conector entre o carimbo
 * real e o alvo alegado) — não existe hoje, e inventar uma agora seria
 * escopo maior do que este achado pede.
 */

export interface CallerIdentityInput {
  /** O id carimbado na URL desta conexão MCP (`/mcp?card=<id>`),
   * atribuído uma vez por `pty-registry.ts` no spawn — fora do alcance do
   * modelo. `undefined`/string vazia: esta conexão não tem registro
   * nenhum (cliente externo genuíno, ou a porta discada direto). */
  urlCardId: string | undefined;
  /** O argumento `callerCardId` que o chamador passou nesta chamada de
   * tool, se algum — inteiramente controlado pelo modelo: pode ser
   * qualquer string, verdadeira ou não. */
  explicitCallerCardId: string | undefined;
}

/** Ver o comentário grande acima pro porquê desta precedência.
 * `urlCardId` vence SEMPRE que presente (não verificável, não
 * sobrescrevível por nenhum argumento de chamada); `explicitCallerCardId`
 * só é consultado como FALLBACK, quando não há carimbo nenhum. String
 * vazia/só espaço conta como ausente nos dois lados — um modelo que
 * preenche `""` não está se identificando. */
export function resolveCallerCardId(input: CallerIdentityInput): string | undefined {
  const stamped = input.urlCardId?.trim();
  if (stamped) return stamped;
  const explicit = input.explicitCallerCardId?.trim();
  return explicit ? explicit : undefined;
}
