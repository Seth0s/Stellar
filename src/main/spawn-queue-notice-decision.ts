/**
 * O aviso que fecha o CARD FANTASMA da fila autônoma (task bf1fb0a7).
 *
 * MEDIDO (board 118, 2026-09-21, instância anterior): duas chamadas antigravity
 * ficaram na fila do board autônomo e resolveram as DUAS às 14:23:07Z — 444s e
 * 238s depois de emitidas. O watchdog do cliente do orquestrador (300s) já
 * tinha abortado as duas: do lado dele, "nada aconteceu". Do lado do app, os
 * cards `97924157` e `97924159` nasceram naquele instante. Às 14:21:29Z o
 * orquestrador escreveu "O spawn criou o card mas parou antes de entregar o
 * brief"; às 14:30:56Z, "há um card que eu não sabia que existia"; às 14:32:30Z
 * mandou para OUTRO card: "não faça a 1172cb32. Outro card (97924157) já a fez
 * enquanto você estava parado: o spawn que me deu timeout criou DOIS cards".
 *
 * Duas consequências, e as duas são trabalho que se perdeu:
 *   1. o chamador não sabia qual card era o seu — briefou à mão um card que não
 *      era dele (97924155, criado 3min19s ANTES da chamada, pelo humano), e o
 *      mesmo enunciado foi entregue a DOIS cards na MESMA árvore;
 *   2. a chamada abortada não deixou nenhum canal pelo qual o cardId chegasse.
 *
 * A chave de idempotência resolve a retentativa (`spawn-idempotency-decision`),
 * mas não resolve (1): quem já desistiu não retenta, não lê `get_delivery` e não
 * tem como adivinhar. Este módulo é o outro canal: quando a fila finalmente
 * despacha um spawn que esperou mais do que qualquer watchdog razoável, o
 * REQUISITANTE recebe o cardId na caixa dele — o mesmo FIFO que já entrega os
 * ponteiros de report/exit. O fato chega por onde o chamador está olhando, em
 * vez de esperar que ele volte a perguntar.
 *
 * O limite existe para não virar ruído: uma espera curta é indistinguível de
 * uma chamada normal que só demorou, e o chamador vai receber a resposta dela.
 * Só o que passou do watchdog típico (300s, medido no cliente do orquestrador)
 * precisa de segunda via — daí o piso bem abaixo disso, para o aviso chegar
 * antes de o card virar trabalho perdido.
 */

/** Piso da espera que faz o aviso valer a pena. Bem abaixo dos 300s do
 * watchdog medido: quando a fila despacha, o chamador pode ter desistido há
 * minutos, e o custo de avisar cedo é uma linha; o de não avisar é trabalho
 * duplicado na mesma árvore. */
export const SPAWN_QUEUE_NOTICE_MIN_WAIT_MS = 30_000;

export function shouldNoticeQueuedSpawnArrival(waitedMs: number): boolean {
  return waitedMs >= SPAWN_QUEUE_NOTICE_MIN_WAIT_MS;
}

/** Agent-facing (inglês — o leitor é um modelo, ver agent-facing.ts). Diz três
 * coisas: qual é o card, quanto a chamada esperou, e o que NÃO fazer agora. */
export function describeQueuedSpawnArrival(input: {
  cardId: string;
  provider: string;
  waitedMs: number;
  label?: string | null;
}): string {
  const seconds = Math.round(input.waitedMs / 1000);
  const named = input.label ? ` labelled ${JSON.stringify(input.label)}` : "";
  return (
    `your queued spawn_agent is UP: card ${input.cardId} (${input.provider})${named} — ` +
    `this call waited ${seconds}s in the autonomous board's queue, past the point where your own client's ` +
    `watchdog is likely to have aborted it. If you already gave up on that call, THIS is your card: ` +
    `do not spawn another one for the same work, and if you already did, close the duplicate — two agents ` +
    `on one tree is how silent overwrites get manufactured.`
  );
}
