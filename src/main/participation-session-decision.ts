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
 * Only providers in `canImposeSessionId` (claude/cursor today) get a
 * `session_id` stamp meant for `spawn_agent({ resumeId })`. Others keep
 * honest null even if a conversation id exists somewhere else.
 */

import { canImposeSessionId } from "./providers";

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
  const resumable = !!card.provider && canImposeSessionId(card.provider);
  return {
    requestedResumeId: null,
    sessionId: resumable ? id : null,
  };
}

/** Should `onSessionFound` write `task_cards.session_id`? */
export function shouldStampParticipationSession(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return canImposeSessionId(provider);
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
