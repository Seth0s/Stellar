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

// BUMP 8→9 (task 23bed0fb): o `send` ganhou `--link-task`/`--link-role` — a
// FORMA do request mudou, e um bus na 8 descartaria os dois campos em silêncio
// (exatamente o que o carimbo existe para impedir). O número mora em DOIS
// lugares: aqui e em `resources/bin/acbridge` (a constante `ACBRIDGE_PROTOCOL`).
// BUMP 12→13 (task 628bdfec): spawn-card CLI gained --reason and --persistent
// (parity with MCP spawn_card.reason / persistent partition for Push API).
// BUMP 13→14: authenticated socket peer ancestry is the only card identity;
// AGENT_CANVAS_CARD_ID / clientCardId are not identity. Preserve spawn-card
// flags from 13.
export const ACBRIDGE_PROTOCOL = 14;

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
      return { accept: true };
    case "acbridge-older":
      return {
        accept: false,
        error:
          `protocol mismatch: acbridge on protocol ${check.theirs}, bus on protocol ${ours}: the client predates authenticated socket identity. ` +
          "Request refused. Reinstall/rebuild Stellar so the client and app use the same protocol.",
      };
    case "acbridge-newer":
      return {
        accept: false,
        error:
          `protocol mismatch: acbridge on protocol ${check.theirs}, bus on protocol ${ours}: the running Stellar is older than this acbridge ` +
          "and would drop fields it does not know without warning. Request refused. Restart Stellar with the build that matches this acbridge " +
          "(dev and packaged share the same socket — check which instance bound first).",
      };
    case "malformed":
      return {
        accept: false,
        error: `protocol mismatch: invalid protocol stamp (${JSON.stringify(check.raw)}); expected an integer >= 1.`,
      };
  }
}

/** Removes protocol and transport identity envelope fields before dispatch. */
export function stripProtocolStamp<T>(request: T): T {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return request;
  const rest = { ...(request as Record<string, unknown>) };
  delete rest[PROTOCOL_KEY];
  delete rest.clientCardId;
  delete rest.clientBoardId;
  delete rest.authToken;
  return rest as T;
}
