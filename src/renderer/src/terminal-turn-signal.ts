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

/**
 * Alimenta UM chunk do PTY e diz se o marcador de fim de turno apareceu.
 *
 * O DEFEITO (task 238388cc; medido no `commandcode` v1.74.1, 2026-10-03): a
 * implementação antiga cortava ANTES de testar —
 * `buffer = (buffer + data).slice(-MAX); if (pattern.test(buffer))`. Um frame
 * de TUI chega como UMA escrita grande (medido na captura real: maior chunk
 * **2214** chars, média 766), e neste TUI o marcador `✻ Worked for 14s` fica no
 * MEIO do frame: medi **460 chars DEPOIS dele no mesmo chunk**. Com a janela de
 * 500 o corte tira o marcador sempre que o que vem depois dele no MESMO chunk
 * passa de 500 — e aí `turn_complete` NUNCA chega. Sem ele, `signalProven` fica
 * falso para sempre, cada byte relâmpa a barra e re-arma o timer de 180s
 * (`terminal-activity-decision.ts`): é o "running eterno / a animação não para"
 * relatado, e explica por que dói mais no provider cujo rodapé é maior.
 *
 * A correção é de ORDEM, não de tamanho: testar o chunk INTEIRO (`tail + data`)
 * e só DEPOIS encolher a janela. A janela continua fazendo o único trabalho que
 * ela tem — costurar um marcador PARTIDO entre dois chunks.
 *
 * `tail` volta sempre; quem chama guarda. `matched` limpa a cauda (o marcador já
 * foi consumido; uma sobra não pode re-disparar num turno seguinte).
 */
export function feedTurnEndChunk(
  tail: string,
  data: string,
  pattern: RegExp,
  max: number = TURN_END_BUFFER_MAX,
): { matched: boolean; tail: string } {
  const combined = tail + data;
  if (pattern.test(combined)) return { matched: true, tail: "" };
  return { matched: false, tail: combined.slice(-max) };
}

/** Traduz a projeção do main no que o terminal precisa. O `RegExp` é
 * REMONTADO aqui: ele não atravessa IPC, então viaja como `source` + `flags`. */
export function readTurnEndSignal(signal: TurnEndProjection): TurnEndReader {
  if (signal === null) return { hasRealTurnSignal: false, pattern: null };
  if (signal.mechanism === "hook") return { hasRealTurnSignal: true, pattern: null };
  return { hasRealTurnSignal: true, pattern: new RegExp(signal.source, signal.flags) };
}
