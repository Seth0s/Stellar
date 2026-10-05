/**
 * A DECISÃO DE ESTADO da pílula do composer global para um `unconfirmed`
 * (2026-10-05, defeito "Sem confirmação · Master: unknown"). Pura e fora do
 * componente para ser testável sem React.
 *
 * O DEFEITO: o laço de confirmação devolve `unconfirmed` quando não teve
 * evidência POSITIVA de submit. Isso cobre DUAS coisas muito diferentes:
 *   - `unknown`: o laço só não VIU a evidência a tempo (o provider pode não
 *     declarar `submitStartedPattern`, ou a TUI não pintou o marcador nos
 *     poucos segundos do laço). A mensagem quase certamente chegou.
 *   - `read-failed` / `card-gone` / `error`: o laço não conseguiu PERGUNTAR.
 * Só o primeiro vira um estado NEUTRO: alarmar e oferecer "tentar de novo" ali
 * induzia o reenvio e a duplicata. Se, depois de uma janela de espera, nenhum
 * sinal positivo nem atividade aparecer, AÍ sim vira alerta.
 */

/**
 * Quanto o estado neutro espera antes de virar alerta. A janela de ~20s é do
 * enunciado; abaixo dela a UI NÃO mostra alerta para um `unknown`.
 */
export const UNCONFIRMED_ESCALATE_MS = 20_000;

/**
 * `unknown` do laço → estado neutro (a mensagem é tratada como enviada). Os
 * OUTROS desfechos de `unconfirmed` (leitura falhou, card sumiu, erro) são uma
 * incerteza mais forte — o laço não pôde perguntar — e seguem alerta.
 */
export function isProvisionalUnknown(delivery: string, loopResult: string | null): boolean {
  return delivery === "unconfirmed" && loopResult === "unknown";
}

/** A janela de espera do estado neutro já passou (vira alerta)? */
export function shouldEscalateUnconfirmed(elapsedMs: number): boolean {
  return elapsedMs >= UNCONFIRMED_ESCALATE_MS;
}
