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

import { APP_NOTICE } from "./agent-facing-notices";

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

/** AGENT-FACING — ENGLISH ONLY, not i18n'd. */
export const REPORT_AVAILABLE_POINTER_BODY =
  APP_NOTICE.reportAvailable();

/** AGENT-FACING — ENGLISH ONLY, not i18n'd. */
export function unreportedExitPointerBody(exitCode: number, taskId?: string | null, cardId?: string | null): string {
  return APP_NOTICE.exitedWithoutReport({ exitCode, taskId, cardId });
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd.
 * SINAL 3 — card still alive, idle long enough, never called report. */
export function unreportedIdlePointerBody(): string {
  return APP_NOTICE.idleWithoutReport({ kind: "turn-ended" });
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd.
 *
 * A QUARTA FRASE (task d77b524b) — e por que ela existe, já que o enunciado
 * mandava reusar uma das três se servisse. As três são:
 *
 *   1. "relatório disponível — chame read_report…" → the card SPOKE and reported;
 *   2. "saiu (código N) sem chamar report." → the card DIED;
 *   3. "idle without calling report." → the card spoke, went quiet and owed a report.
 *
 * Nenhuma das três é verdadeira aqui: o card NÃO morreu (segue vivo), NÃO ficou
 * ocioso depois de trabalhar (nunca produziu um byte), e não há report pendente
 * — ele pode não estar vinculado a task nenhuma (foi spawnado com um brief).
 * Dizer "idle sem chamar report" seria acusar de ócio um processo que talvez
 * esteja preso ANTES de desenhar a primeira tela; e o dono decidiu, nesta task,
 * AVISAR e NUNCA MATAR — a frase tem de caber nessa decisão. Então ela diz o
 * que se sabe (nenhum byte, quantos segundos), o que NÃO se sabe (por quê) e o
 * que NÃO foi feito (nada foi encerrado). */
export function silentBootPointerBody(waitedSec: number, cardId = "unknown"): string {
  return APP_NOTICE.silentBoot({ cardId, waitedSec });
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd.
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
export function unreportedNoAgentPointerBody(taskId?: string | null, cardId?: string | null): string {
  return APP_NOTICE.idleWithoutReport({ kind: "no-agent", taskId, cardId });
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd.
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
export function unreportedUnprovenIdlePointerBody(idleMs: number, taskId?: string | null, cardId?: string | null): string {
  return APP_NOTICE.idleWithoutReport({ kind: "unproven", idleMinutes: idleMs / 60_000, taskId, cardId });
}

/** AGENT-FACING — ENGLISH ONLY, not i18n'd.
 *
 * The reminder typed into the card ITSELF when it ended its turn without
 * calling `report` (idle self-reminder). Not a card-to-card message: it carries
 * no `[de: …]` prefix, so the agent reads it as the app's own notice, like the
 * "task for you" pointer. It leaves room for the card to be wrong about being
 * done — "if you are not done, ignore this" — because the screen proves the turn
 * ended, never that the work did. */
export function selfReportReminderBody(taskId: string): string {
  return APP_NOTICE.selfReportReminder(taskId);
}
