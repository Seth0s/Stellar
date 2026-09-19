/**
 * Achado ao vivo (2026-09-13): o `acbridge` que um agente executa é o do
 * PACOTE instalado (`/opt/Stellar/resources/bin`, copiado de
 * `resources/bin` pelo `extraResources` do electron-builder), não o do
 * repo — e nada avisava quando os dois divergiam. Sintoma medido: o card
 * de crítica mandou `acbridge report '{"verdict":"reprovado"}'` por um
 * acbridge que ainda não promovia `verdict`; o bus da mesma build também
 * não promovia; o relatório entrou com `reports.verdict = NULL` e o
 * "reprovado" preso no `report_json` (seq 213). O agente recebeu `ok`.
 *
 * A classe do defeito não é "esqueceram de rebuildar" — é que acbridge e
 * bus falam um protocolo JSON-line sem NENHUMA marca de versão, então
 * qualquer defasagem entre os dois lados é silenciosa: campos que um lado
 * manda e o outro não conhece somem sem erro. Os dois lados divergem de
 * verdade quando dev e empacotado compartilham o mesmo `userData` (mesmo
 * `agent-canvas.sock`, ver message-bus.ts): quem bindou primeiro atende os
 * acbridges DOS DOIS — o `resources/bin` do repo (PATH do card do dev) e
 * o `/opt/.../bin` (PATH do card do empacotado).
 *
 * Mecanismo: um inteiro `protocol` carimbado pelo acbridge em TODO request
 * e devolvido pelo bus em `hello`. Este módulo decide o que o bus faz com
 * a comparação — puro, sem I/O, testável.
 *
 * Política, assimétrica de propósito:
 * - acbridge MAIS VELHO que o bus (ou sem carimbo — todo acbridge anterior
 *   a esta constante, e clientes crus como os smokes de `scripts/verify`):
 *   o request é um SUBCONJUNTO que o bus entende inteiro, nada se perde →
 *   ACEITA e avisa. Recusar aqui derrubaria todo card vivo com acbridge
 *   antigo sem ganho nenhum.
 * - acbridge MAIS NOVO que o bus: o request pode carregar campos que este
 *   bus deixa cair sem saber quais → RECUSA com erro acionável. É
 *   exatamente o caso "recebe ok e o dado se perde", e um erro visível é
 *   o único jeito de um bus antigo não mentir.
 *
 * Bump de `ACBRIDGE_PROTOCOL`: quando a FORMA do request muda (cmd novo,
 * campo novo, semântica nova de um campo). O mesmo literal vive em
 * `resources/bin/acbridge` (script standalone, sem import daqui);
 * `tests/unit/acbridge-protocol.test.ts` trava os dois em lockstep e
 * fixa um hash da superfície de requests do acbridge para que mudar a
 * forma sem bumpar falhe no vitest, não em produção.
 */

export const ACBRIDGE_PROTOCOL = 4;

/** Chave carimbada pelo acbridge no JSON do request. Removida antes do
 * dispatch — nenhum cmd do bus a vê. */
export const PROTOCOL_KEY = "protocol";

export type ProtocolCheck =
  | { kind: "match"; theirs: number }
  /** Sem carimbo: acbridge anterior a `ACBRIDGE_PROTOCOL = 1`, ou um
   * cliente cru no socket (smoke tests). Tratado como "mais velho". */
  | { kind: "unstamped" }
  | { kind: "acbridge-older"; theirs: number }
  | { kind: "acbridge-newer"; theirs: number }
  /** Carimbo presente mas não é inteiro ≥ 1 — cliente quebrado, não
   * "velho". Recusado: não dá pra saber o que ele acha que fala. */
  | { kind: "malformed"; raw: unknown };

export function checkAcbridgeProtocol(request: unknown, ours: number = ACBRIDGE_PROTOCOL): ProtocolCheck {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return { kind: "unstamped" };
  if (!Object.prototype.hasOwnProperty.call(request, PROTOCOL_KEY)) return { kind: "unstamped" };
  const raw = (request as Record<string, unknown>)[PROTOCOL_KEY];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return { kind: "malformed", raw };
  if (raw === ours) return { kind: "match", theirs: raw };
  return raw < ours ? { kind: "acbridge-older", theirs: raw } : { kind: "acbridge-newer", theirs: raw };
}

export type ProtocolDecision =
  | { accept: true; warning?: string }
  | { accept: false; error: string };

/** O que o bus faz com um request dado o resultado da comparação. */
export function decideAcbridgeProtocol(check: ProtocolCheck, ours: number = ACBRIDGE_PROTOCOL): ProtocolDecision {
  switch (check.kind) {
    case "match":
      return { accept: true };
    case "unstamped":
      return {
        accept: true,
        warning:
          `acbridge sem carimbo de protocolo (anterior ao protocolo ${ours}) falando com um bus no protocolo ${ours}. ` +
          "O request é aceito, mas o acbridge instalado está atrasado em relação ao Stellar em execução — " +
          "campos e comandos novos não existem nele. Reinstale/rebuild o pacote ou rode o acbridge do repo.",
      };
    case "acbridge-older":
      return {
        accept: true,
        warning:
          `acbridge no protocolo ${check.theirs}, bus no protocolo ${ours}: o acbridge está atrasado. ` +
          "O request é aceito (subconjunto), mas comandos/campos novos não existem nesse acbridge. " +
          "Reinstale/rebuild o pacote ou rode o acbridge do repo.",
      };
    case "acbridge-newer":
      return {
        accept: false,
        error:
          `protocol mismatch: acbridge no protocolo ${check.theirs}, bus no protocolo ${ours}: o Stellar em execução é mais velho que este acbridge ` +
          "e deixaria cair campos que não conhece sem avisar. Request recusado. Reinicie o Stellar com a build que casa com este acbridge " +
          "(dev e empacotado compartilham o mesmo socket — veja qual instância bindou primeiro).",
      };
    case "malformed":
      return {
        accept: false,
        error: `protocol mismatch: carimbo de protocolo inválido (${JSON.stringify(check.raw)}); esperado um inteiro >= 1.`,
      };
  }
}

/** Devolve o request sem a chave de protocolo — o dispatcher nunca a vê,
 * então nenhum `cmd` precisa declará-la no tipo. */
export function stripProtocolStamp<T>(request: T): T {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return request;
  if (!Object.prototype.hasOwnProperty.call(request, PROTOCOL_KEY)) return request;
  const rest = { ...(request as Record<string, unknown>) };
  delete rest[PROTOCOL_KEY];
  return rest as T;
}
