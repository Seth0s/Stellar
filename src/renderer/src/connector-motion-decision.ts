/**
 * Quando o traço "marchante" de um conector deve ser animado — e quando
 * ele pode parar de desenhar.
 *
 * Contexto (2026-09-15, PERF — ver docs/PERF.md): medido pelo orquestrador,
 * o app queima ~11% de CPU com o board PARADO (gpu-process 4,6% + renderer
 * 4,1% + main 2,4%). Leitura de código isolou a fonte contínua mais barata
 * de desligar: `styles/animations.css` aplica
 * `animation: dash 1.1s linear infinite` a TODO `.connector-line`. A
 * animação caminha `stroke-dashoffset` para sempre, em todo conector
 * tracejado do board — e `stroke-dashoffset` não é propriedade de
 * compositor (transform/opacity), é PAINT: cada frame invalida e
 * re-rasteiriza o traço, mesmo com o board imóvel e nenhum agente
 * produzindo. O board "parado" da medição tinha cards (stickies, fila de
 * tasks) e, portanto, conectores — era exatamente esse repintar eterno.
 *
 * O tracejado estático continua existindo (a cor por `kind` — signal/
 * danger/violet — e o padrão `6 6` já dizem "aresta" sem mover nada). O
 * que esta decisão responde é só se o MARCHA (a animação contínua) tem
 * direito de existir AGORA: apenas enquanto o board está de fato
 * trabalhando — tem um card de agente vivo (provider ≠ bash, não
 * error/exited) ou uma task em `running`.
 *
 * Por que não animar só pelo hover do mouse: o orquestrador move o mouse
 * zero vezes no caso medido. Hover é interação, não atividade de board.
 * Por que não ordenar pelo `visibilityState` da janela: board em segundo
 * plano com agente rodando ainda merece o cue quando o usuário volta;
 * o que custa é repintar SEM nada produzindo, não com a janela oculta.
 */
export type ConnectorMotionInput = {
  /** Há ao menos um card de terminal de agente (provider ≠ bash) vivo agora. */
  anyLiveAgentCard: boolean;
  /** Há ao menos uma task em `running` (`doing`) no quadro deste board. */
  anyTaskRunning: boolean;
};

/**
 * Puro — sem DOM, sem I/O, sem estado. Consumido por App.tsx, que resolve
 * os dois booleanos a partir de `liveStatus` e `taskBoards[activeBoardId]`
 * e pendura a classe `connectors-animated` no SVG `.board-overlay`.
 */
export function decideConnectorMotion(input: ConnectorMotionInput): boolean {
  return input.anyLiveAgentCard || input.anyTaskRunning;
}
