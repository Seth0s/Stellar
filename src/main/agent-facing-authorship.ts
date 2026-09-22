/**
 * Single source of truth for the agent-facing authorship prefix
 * (`[de: <label>] …`) that lands in a PTY via `send_to_card` or the
 * report / exit-without-report pointers.
 *
 * Why this module exists (2026-09-14, live double-prefix on card 330):
 * `send` stamped `[de: ${senderLabel}] ${text}` while callers (and the
 * report pointer) could already ship a line that started with the same
 * convention. Two construction sites, neither aware of the other → one
 * delivery, two prefixes. The defect is a second source of truth in
 * *presentation*, not a missing string guard.
 *
 * Design cut (seq 232 — reapplied after git reset --hard wiped the tree):
 * - Form is assembled HERE only. `send` and `notifySpawnerOfReport` /
 *   `notifySpawnerOfUnreportedExit` / `notifySpawnerOfUnreportedIdle`
 *   both call this; they do not hand-roll
 *   the prefix. `enqueueCardDelivery` stays a dumb FIFO of final text —
 *   status-write / task-drag already author full lines with synthetic
 *   labels (`stellar`, `você`) and are not "card X says Y".
 * - Authorship-as-data through the delivery queue would be cleaner
 *   internally, but the PTY consumer still reads text. The prefix is the
 *   legitimate wire format to the agent; this helper is where `from` (data)
 *   becomes that wire form, once.
 * - Skipping when the body already carries `[de: …]` is a defensive
 *   property of the single formatter (freeform `send_to_card` text can
 *   copy the convention). Alone inside `send` it would be a patch; here
 *   it is what keeps one form idempotent.
 * - No content dedupe in the FIFO: two byte-identical deliveries can be
 *   intentional (card 469, seq 222+223). Identity is the delivery `id`.
 */

/** True when `text` already opens with the authorship convention. */
export function hasAgentFacingAuthorPrefix(text: string): boolean {
  return /^\[de:\s*[^\]]+\]/.test(text);
}

/**
 * Render authorship for a PTY-bound line.
 * - `from` empty → body unchanged (bash targets / anonymous send).
 * - body already authored → body unchanged (no second stamp).
 * - else → `[de: ${from}] ${body}`.
 */
export function formatAgentFacingAuthorship(from: string | null | undefined, body: string): string {
  const text = body ?? "";
  if (!from) return text;
  if (hasAgentFacingAuthorPrefix(text)) return text;
  return `[de: ${from}] ${text}`;
}

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n). */
export const REPORT_AVAILABLE_POINTER_BODY =
  "relatório disponível — chame read_report para ver o resultado.";

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n). */
export function unreportedExitPointerBody(exitCode: number): string {
  return `saiu (código ${exitCode}) sem chamar report.`;
}

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
 * SINAL 3 — card still alive, idle long enough, never called report. */
export function unreportedIdlePointerBody(): string {
  return "idle sem chamar report.";
}

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
 *
 * A QUARTA FRASE (task d77b524b) — e por que ela existe, já que o enunciado
 * mandava reusar uma das três se servisse. As três são:
 *
 *   1. "relatório disponível — chame read_report…" → o card FALOU e reportou;
 *   2. "saiu (código N) sem chamar report." → o card MORREU;
 *   3. "idle sem chamar report." → o card falou, ficou quieto e devia report.
 *
 * Nenhuma das três é verdadeira aqui: o card NÃO morreu (segue vivo), NÃO ficou
 * ocioso depois de trabalhar (nunca produziu um byte), e não há report pendente
 * — ele pode não estar vinculado a task nenhuma (foi spawnado com um brief).
 * Dizer "idle sem chamar report" seria acusar de ócio um processo que talvez
 * esteja preso ANTES de desenhar a primeira tela; e o dono decidiu, nesta task,
 * AVISAR e NUNCA MATAR — a frase tem de caber nessa decisão. Então ela diz o
 * que se sabe (nenhum byte, quantos segundos), o que NÃO se sabe (por quê) e o
 * que NÃO foi feito (nada foi encerrado). */
export function silentBootPointerBody(waitedSec: number): string {
  return (
    `subiu e não produziu nenhum byte em ${waitedSec}s — o processo está VIVO e calado, e nada foi encerrado. ` +
    "Pode ser credencial faltando (CLI pendurada antes do primeiro desenho), prompt de login, ou binário preso; " +
    "confira a tela antes de decidir."
  );
}

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
 *
 * SINAL 3, a OUTRA frase (task 14b8b224): o card está ocioso e vinculado a uma
 * task, mas não há agente lendo a linha — então "não reportou" seria falso (não
 * havia quem reportasse). O que o dono precisa saber é o que fazer: o vínculo
 * está vivo e o card não executa nada.
 *
 * Por que NÃO é silêncio: um card de shell que nunca recebe agente ficaria
 * esquecido com uma task viva, e é exatamente esse o risco que a peça 7 do
 * rastreamento (90080872) existe para não deixar acontecer. Por que NÃO é a
 * frase de cima: acusar quem não tem leitor ensina o orquestrador a ignorar o
 * alarme — e é assim que o sinal verdadeiro morre. */
export function unreportedNoAgentPointerBody(): string {
  return "ocioso e sem agente lendo (shell com prompt livre) — suba um agente neste card ou re-vincule a task.";
}

/** AGENT-FACING — DO NOT TRANSLATE (DESIGN-BACKLOG.md §2.1 i18n).
 *
 * SINAL 3, a TERCEIRA frase (task 14b8b224, caso (b)): o card tem agente, está
 * vinculado, e ficou quieto além do piso — mas NADA declarou o fim do turno.
 * Nesse estado o app não sabe distinguir "terminou e não reportou" de "está
 * trabalhando" nem de "está à espera de instrução" (medição no cabeçalho de
 * idle-without-report-decision.ts: o store não guarda mensagem recebida por
 * card, e o fato que existe em memória é o que ARMA o watchdog).
 *
 * Então a frase diz o que sabe — há quanto tempo o card está quieto — e pede a
 * conferência, em vez de afirmar abandono. Quem confere é quem tem tela: o
 * orquestrador (`read_card`), não o relógio de bytes.
 *
 * Por que não silêncio: o card que MORREU calado tem exatamente esta assinatura.
 * Um watchdog que se cala nos dois casos perde o verdadeiro — e o que se
 * aprende a ignorar é o alarme que erra, que é o que esta frase conserta. */
export function unreportedUnprovenIdlePointerBody(idleMs: number): string {
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return `sem chamar report há ${minutes}min e sem fato de turno — silêncio, não abandono: confira o card antes de retomar.`;
}
