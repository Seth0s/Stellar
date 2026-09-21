import type { TurnEndProjection } from "../../main/agent-availability-projection";

/**
 * QUEM CONSEGUE FECHAR UM TURNO por sinal real, e não por silêncio (task
 * 0dd5c145).
 *
 * A DECLARAÇÃO mora no main (`capacity.delivery.turnEnd`, `providers.ts`) e
 * chega aqui pela projeção do canal de disponibilidade — este módulo só
 * TRADUZ o que atravessou. Antes disto a resposta era um `id === "claude"`
 * cravado aqui, mais uma tabela `TURN_END_PATTERNS` ao lado: as duas juntas
 * afirmavam "só claude e codex sabem terminar um turno", o que já era FALSO —
 * o commandcode tem um sistema de `Stop` hooks compatível com o do Claude
 * Code (medido no bundle instalado). Medir a ausência no nosso repo não prova
 * a ausência do outro lado.
 *
 * O vocabulário de INÍCIO de turno é OUTRO campo (`submitStartedPattern`,
 * também no main) e de propósito não se reusa aqui: "esta CLI aceitou o
 * prompt?" e "esta CLI terminou o turno?" são perguntas diferentes. O cursor,
 * por exemplo, declara início e não declara fim — enquanto ele continua
 * imprimindo, `isActive` fica true, que é o correto; quando o output para, ele
 * cai no mesmo relógio de silêncio do shell.
 *
 * `null` na projeção = este provider NÃO sinaliza, e a UI não promete: a barra
 * de atividade cai no silêncio
 * (`terminal-activity-decision.ts`'s `ACTIVITY_UNPROVEN_SIGNAL_IDLE_MS`) e
 * nenhum aviso de SO é disparado por aproximação. Mesma regra da ausência de
 * esforço.
 */
export type TurnEndReader = {
  /** Existe sinal de fim de turno para este provider — hook OU tela. */
  hasRealTurnSignal: boolean;
  /** O marcador de TEXTO, quando o mecanismo é `screen`. `null` no `hook`:
   * ali o sinal chega nomeado por IPC (`pty:turn-complete`), não por texto. */
  pattern: RegExp | null;
};

/** Rolling window that keeps a split marker intact across `pty:data` chunks. */
export const TURN_END_BUFFER_MAX = 500;

/** Traduz a projeção do main no que o terminal precisa. O `RegExp` é
 * REMONTADO aqui: ele não atravessa IPC, então viaja como `source` + `flags`. */
export function readTurnEndSignal(signal: TurnEndProjection): TurnEndReader {
  if (signal === null) return { hasRealTurnSignal: false, pattern: null };
  if (signal.mechanism === "hook") return { hasRealTurnSignal: true, pattern: null };
  return { hasRealTurnSignal: true, pattern: new RegExp(signal.source, signal.flags) };
}
