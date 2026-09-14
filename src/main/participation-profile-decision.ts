/**
 * Execution PROFILE on a participation (`task_cards`), not on the task.
 *
 * Provider / model / effort that actually went to spawn argv are facts
 * about "a card doing a role on a task". The same task can run an
 * implementer on one provider and a reviewer on another — a per-task
 * profile cannot say that (owner 2026-09-13).
 *
 * Deliberately separate from task CONTRACT (territory/gates/allowCommit/
 * reportSchema in task-contract-decision.ts): profile → argv / audit;
 * contract → brief text / report acceptance.
 *
 * Intention fields for model/effort on the TASK are NOT created here.
 * Measured fill rates (`purpose` 3/96, `cards.model`/`cards.effort` 0/10)
 * say a field without a defaulting consumer stays empty; the recorded
 * fact on the participation is what answers "with which model was this
 * reviewed". Task still carries `provider`/`cwd` for dispatch routing —
 * those already have consumers.
 */

export type ParticipationProfile = {
  provider: string | null;
  model: string | null;
  effort: string | null;
};

/** Empty / whitespace → null. Never invent a default provider. */
export function normalizeProfileField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function profileFromSpawnArgs(input: {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
}): ParticipationProfile {
  return {
    provider: normalizeProfileField(input.provider),
    model: normalizeProfileField(input.model),
    effort: normalizeProfileField(input.effort),
  };
}

export function profileFromCardRow(card: {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
} | null | undefined): ParticipationProfile {
  if (!card) return { provider: null, model: null, effort: null };
  return profileFromSpawnArgs(card);
}
