/**
 * Spawn registry — who spawned whom, and why.
 *
 * Declared by the agent: only `reason` (the app cannot derive motive).
 * Everything else (requester, newborn, board, task, depth, time, provider,
 * cwd) is derived by the bus at spawn time or on read.
 *
 * NOT a gate on spawning in general (owner 2026-09-14): the only refusal
 * here is a missing `reason` on an AGENT-initiated spawn. Human UI and
 * system (empty requester) never owe a reason. Register always; notify
 * never — the orchestrator polls this table when it wants lineage.
 */

export type SpawnOrigin = "agent" | "human" | "system";

export type SpawnReasonDecision =
  | { action: "accept"; reason: string | null; origin: SpawnOrigin }
  | { action: "refuse"; error: string };

/** Same teaching style as `describeStructuralReportError` — name the field. */
export function describeMissingSpawnReason(): string {
  return 'missing reason — spawn by an agent requires reason (why this card); refusing rather than recording an empty "why"';
}

/**
 * Agent = non-empty requester card id (MCP/acbridge caller).
 * Human / system paths pass no requester and never require reason.
 */
export function decideSpawnReason(input: {
  requesterId: string | null | undefined;
  reason: unknown;
}): SpawnReasonDecision {
  const requester =
    typeof input.requesterId === "string" && input.requesterId.trim().length > 0
      ? input.requesterId.trim()
      : null;

  if (!requester) {
    const trimmed =
      typeof input.reason === "string" && input.reason.trim().length > 0 ? input.reason.trim() : null;
    return { action: "accept", reason: trimmed, origin: "system" };
  }

  if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
    return { action: "refuse", error: describeMissingSpawnReason() };
  }
  return { action: "accept", reason: input.reason.trim(), origin: "agent" };
}

/**
 * Depth of `toCardId` in the spawn chain: walk parents until a root
 * (no parent, or parent with null from_card_id). Does not use the
 * in-memory `cardSpawnDepth` Map — survives restart.
 */
export function deriveSpawnDepth(
  toCardId: string,
  parentOf: (cardId: string) => { from_card_id: string | null } | null | undefined,
): number {
  let depth = 0;
  let current: string | null = toCardId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const parent = parentOf(current);
    if (!parent) break;
    if (!parent.from_card_id) break;
    depth += 1;
    current = parent.from_card_id;
  }
  return depth;
}
