/**
 * O ack do `send_to_card` ao REMETENTE — e por que ele é RARO (task 40e3b551).
 *
 * MEDIDO (sessão do orquestrador 3166d2b0): **888** chamadas `send_to_card`
 * contra **10** menções a `get_delivery` (~1%). A ferramenta devolvia
 * `{delivery:"queued"}` — verdade sobre o enfileiramento, nada sobre a chegada —
 * e o remetente repetia "para garantir": 5 mensagens daquela janela se anunciam
 * como duplicata/complemento/ping, e **0** das 33 longas eram duplicatas
 * byte-a-byte (por isso um guarda por conteúdo não pegaria nenhuma: os reenvios
 * são REESCRITOS por falta de confirmação).
 *
 * PRIMEIRA forma, DESCARTADA por medição: esperar o desfecho dentro do `send`.
 * A própria suíte pina o incidente de 2026-09-13 (`send-does-not-await-pty`): um
 * `send` que esperava o PTY ficou preso no portão humano, o cliente MCP estourou
 * e RE-DIGITOU o mesmo texto.
 * SEGUNDA forma, DESCARTADA pelo dono: ack em TODA entrega. 888 acks seriam 888
 * linhas novas na sessão do orquestrador — e, num orquestrador claude, cada
 * linha é um turno para ler. Trocava um ruído por outro maior.
 *
 * A FORMA VIGENTE, decisão do dono: **silêncio = entregue**. O retorno e a
 * descrição da ferramenta dizem isso; o ack é digitado SÓ quando a entrega NÃO
 * é limpa (não confirmada, falhou, cancelada, ou ficou na fila mid-turn do
 * destino sem o agente ver). O remetente deixa de duvidar — e o caminho comum
 * não ganha nenhuma linha.
 */


import type { CardDeliveryState } from "./type-and-submit-decision";

/** `true` só quando o remetente PRECISA saber: silêncio é o caso feliz.
 *
 * Medido: 888 sends numa sessão. Um ack por send seriam 888 linhas novas — e
 * num orquestrador claude cada linha é um turno. Só o que não é entrega limpa
 * vale interromper o autor. */
export function shouldAckSendSettlement(state: CardDeliveryState): boolean {
  return state !== "delivered";
}

/** A frase do ack — agent-facing (inglês), uma linha, e diz o que FAZER. */
export function describeSendSettlementAck(input: {
  state: Exclude<CardDeliveryState, "delivered">;
  id: string;
  target: string;
}): string {
  if (input.state === "parked") {
    return (
      `NOT seen yet: card ${input.target} took your message into its own mid-turn queue (delivery ${input.id}) ` +
      `— the agent reads it when the current turn ends. Do not resend; it is already there.`
    );
  }
  if (input.state === "cancelled") {
    return `NOT delivered: the sender's process exited before typing started (delivery ${input.id}, card ${input.target}) — resend if it still matters.`;
  }
  return (
    `NOT confirmed in card ${input.target} (delivery ${input.id}, ${input.state}) — the text may not have landed: ` +
    `check read_card ${input.target} (or get_delivery("${input.id}")) before deciding to resend.`
  );
}
