/**
 * Session identity on a participation (`task_cards`), same layer as
 * provider/model/effort (Camada 2).
 *
 * `requested_resume_id` = what spawn asked for (may be null on a fresh
 * spawn). `session_id` = what `onSessionFound` discovered (or the id
 * imposed at spawn for claude/cursor). They are NOT the same: a resume
 * can land on a different file than the one requested (measured for
 * claude in DESIGN-BACKLOG), and a fresh spawn has no request.
 *
 * Resume target prefers the discovered id; falls back to the request
 * only when discovery never happened (nullable — never invent).
 *
 * WHO GETS A `session_id` (task 11914cc7 — corrigido): antes o carimbo exigia
 * `canImposeSessionId` (só claude/cursor aceitam um id ESCOLHIDO no spawn), e
 * por isso commandcode/antigravity/opencode/cline/codex ficavam `null` MESMO
 * tendo o id em disco — medido ao vivo: um card `commandcode` morreu no meio de
 * uma task e não deu para retomar. A pergunta certa é DUAS: a CLI ESCREVE um
 * id observável (`providerExposesSession` → tem `store`) E sabe RETOMAR por ele
 * (`providerResumesById` → alguma flag + o `resumeById` do codex). O id é
 * OBSERVADO pelo sistema (`onSessionFound`), nunca declarado pelo agente.
 *
 * `sessionResumeOutlook` fecha o terceiro caso: CLI que expõe sessão mas NÃO
 * retoma por ela — aí `sessionId` fica `null` COM MOTIVO, para virar aviso, e
 * nunca o silêncio de antes. Ausência de store continua sendo dado: um provider
 * sem canal de descoberta não é observável e não há o que inventar.
 */

import { providerExposesSession, providerResumesById } from "./providers";

/** A CLI expõe um id de sessão observável E sabe retomar por ele? É o par que
 * autoriza carimbar `session_id` e oferecê-lo como `spawn_agent({ resumeId })`.
 * Um só dos dois não basta: observável-mas-não-retomável não é retomável. */
export function canResumeObservedSession(providerId: string | null | undefined): boolean {
  return providerExposesSession(providerId) && providerResumesById(providerId);
}

export type ParticipationSession = {
  requestedResumeId: string | null;
  sessionId: string | null;
};

export function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Stamp at link/spawn — request only; discovery writes sessionId later. */
export function sessionFromSpawnArgs(input: {
  resumeId?: string | null;
}): Pick<ParticipationSession, "requestedResumeId"> {
  return { requestedResumeId: normalizeSessionId(input.resumeId) };
}

/**
 * When linking an ALREADY-open card that already knows its resume_id,
 * copy it into session_id for resumable providers. Non-resumable → null.
 */
export function sessionFromCardRow(card: {
  provider?: string | null;
  resume_id?: string | null;
} | null | undefined): ParticipationSession {
  if (!card) return { requestedResumeId: null, sessionId: null };
  const id = normalizeSessionId(card.resume_id);
  return {
    requestedResumeId: null,
    sessionId: canResumeObservedSession(card.provider) ? id : null,
  };
}

/** Should `onSessionFound` write `task_cards.session_id`? Todo provider cujo id
 * é OBSERVÁVEL e RETOMÁVEL — não só quem impõe o id no spawn. */
export function shouldStampParticipationSession(provider: string | null | undefined): boolean {
  return canResumeObservedSession(provider);
}

/**
 * Por que (não) dá para retomar um card deste provider — o NÃO-SILÊNCIO que a
 * task 11914cc7 pede. `resumable`: id observável e `resumeId` honrado.
 * `unobservable`: a CLI não declara store (nada a observar; ausência é dado).
 * `observed-not-resumable`: há id em disco mas a CLI não sabe retomar por ele —
 * `sessionId` fica null COM esta razão, pronta para virar aviso visível, em vez
 * do `null` mudo de antes.
 */
export type SessionResumeOutlook =
  | { kind: "resumable" }
  | { kind: "unobservable" }
  | { kind: "observed-not-resumable"; warning: string };

/** Núcleo PURO (sem `providerById`): as três respostas a partir dos dois
 * booleanos já derivados. Existe separado para que o ramo do AVISO — que
 * NENHUM provider medido atinge hoje — seja testável sem inventar um
 * provider no registro. */
export function decideSessionResumeOutlook(label: string, exposes: boolean, resumes: boolean): SessionResumeOutlook {
  if (!exposes) return { kind: "unobservable" };
  if (resumes) return { kind: "resumable" };
  return {
    kind: "observed-not-resumable",
    warning:
      `${label} writes a session id we can observe on disk, but its CLI declares no way to resume by it` +
      " — the id is recorded as absent-for-resume on purpose, not silently dropped",
  };
}

export function sessionResumeOutlook(provider: string | null | undefined): SessionResumeOutlook {
  const label = typeof provider === "string" && provider.trim().length > 0 ? provider : "this provider";
  return decideSessionResumeOutlook(label, providerExposesSession(provider), providerResumesById(provider));
}

/**
 * Id to pass as `spawn_agent({ resumeId })` for "retomar AQUELA sessão".
 * Prefer discovered; fall back to requested; else null (cannot resume).
 */
export function resumeTargetFromParticipation(row: {
  session_id?: string | null;
  requested_resume_id?: string | null;
  sessionId?: string | null;
  requestedResumeId?: string | null;
}): string | null {
  const discovered = normalizeSessionId(row.session_id ?? row.sessionId);
  if (discovered) return discovered;
  return normalizeSessionId(row.requested_resume_id ?? row.requestedResumeId);
}
