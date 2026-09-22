/**
 * O que `spawn_agent` TEM DE DIZER sobre o brief que lhe pediram para entregar.
 *
 * MEDIDO (task bf1fb0a7, 2026-09-22, board 118, build 6c42314):
 *
 *  - a chamada devolvia `{ok:true, cardId}` para quatro situações
 *    INDISTINGUÍVEIS de fora: (a) o card nasceu com brief em argv; (b) o card
 *    nasceu com o texto apenas ENFILEIRADO para digitação posterior; (c) o card
 *    nasceu sem brief nenhum, porque o chamador não mandou nenhum; (d) o brief
 *    foi enfileirado e a entrega morreu depois. O orquestrador recebeu a mesma
 *    string nos quatro casos e teve de descobrir por fora qual era o seu —
 *    quando descobriu.
 *  - o caso (c) é o que produziu a queixa "o spawn não entrega o brief": as
 *    quatro chamadas de 2026-09-22 no transcript do orquestrador
 *    (`~/.claude/projects/.../*.jsonl`, linhas 17194/17223/17224/17269) não
 *    carregavam `brief` nem `taskId`. A ferramenta respondeu `{ok:true}` —
 *    verdade sobre o CARD, mentira sobre o que se esperava dele.
 *
 * Este módulo é a resposta: uma frase e três fatos por spawn, derivados do que
 * de fato aconteceu com o texto — nunca do que se pretendia.
 *
 * `briefDelivered` significa "o processo nasceu com o texto no argv" (a única
 * entrega que NÃO depende de nada posterior) ou "o texto já está no card"
 * (`edit_task`/`update_task` prompt-append, fora do escopo daqui). Para o
 * caminho digitado ele é FALSE por definição: a entrega está na fila, e quem
 * respondeu isso não sabe o veredito — dizer `true` ali seria exatamente a
 * "afirmação que o sistema não pode sustentar" que este módulo existe para
 * eliminar. O `briefDeliveryId` é o que torna o veredito CONSULTÁVEL
 * (`get_delivery`) em vez de adivinhado.
 */

export type SpawnBriefMode = "argv" | "typed" | "none";

export type SpawnBriefDeliveryInput = {
  /** Texto resolvido para este spawn (prompt da task ou `brief` livre). */
  hasBrief: boolean;
  /** `argvCarriesDeclaredBrief` — sondado no argv REAL, nunca na declaração. */
  canArgv: boolean;
  /** Acima do padding do ARG_MAX: não cabe no argv, por maior que seja. */
  tooLarge: boolean;
  /** Recibo da FIFO, quando o caminho digitado de fato enfileirou o texto. */
  typedDeliveryId?: string;
};

export type SpawnBriefDeliveryReport = {
  /** `true` só quando o texto está no LAUNCH do processo. */
  briefDelivered: boolean;
  briefMode: SpawnBriefMode;
  /** Presente quando o veredito é consultável: `get_delivery(briefDeliveryId)`. */
  briefDeliveryId?: string;
  /** Frase agent-facing (inglês — o leitor é um modelo, ver agent-facing.ts). */
  briefNote: string;
};

/** Onde o texto deste spawn foi parar. Puro: três fatos, nenhuma heurística. */
export function decideSpawnBriefMode(
  input: Pick<SpawnBriefDeliveryInput, "hasBrief" | "canArgv" | "tooLarge">,
): SpawnBriefMode {
  if (!input.hasBrief) return "none";
  return input.canArgv && !input.tooLarge ? "argv" : "typed";
}

export function describeSpawnBriefDelivery(input: SpawnBriefDeliveryInput): SpawnBriefDeliveryReport {
  const mode = decideSpawnBriefMode(input);
  if (mode === "none") {
    return {
      briefDelivered: false,
      briefMode: "none",
      briefNote:
        "the card was born with NO brief — nothing was sent in this call, and the card will sit idle at an empty prompt until you deliver one (send_to_card, or spawn with `brief`/`taskId`)",
    };
  }
  if (mode === "argv") {
    return {
      briefDelivered: true,
      briefMode: "argv",
      briefNote: "the brief rode the launch argv — the process was started with it, nothing to poll",
    };
  }
  const id = input.typedDeliveryId;
  return {
    briefDelivered: false,
    briefMode: "typed",
    ...(id ? { briefDeliveryId: id } : {}),
    briefNote: id
      ? `the brief is only QUEUED for typing into the card (delivery ${id}) — it is NOT delivered yet; poll get_delivery("${id}") for the settled verdict`
      : "the brief was NOT delivered: this provider cannot carry it in argv and the typed delivery was never enqueued (the card exists; the text does not)",
  };
}
