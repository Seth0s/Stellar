import type { IdentifyResult } from "./session-identify";

/**
 * Turns a deterministic identify result into the IPC payload the
 * renderer persists. The only extra gate is ownership: an id already
 * claimed by another card is not written. This does not call
 * `claimSessionId` — claiming here without updating the PTY entry's
 * `claimedSessionId` would leak on close and make this card's own
 * watcher skip the correct id.
 */

export type IdentifyApplyResult =
  | { status: "found"; id: string; source: string; via?: string }
  | {
      status: "ambiguous";
      ids: string[];
      source: string;
      candidates?: Array<{ id: string; title?: string; createdAtMs?: number; updatedAtMs?: number }>;
    }
  | { status: "none"; source: string }
  | { status: "claimed"; id: string; source: string }
  | { status: "error"; source: string; message: string }
  | { status: "already-set" }
  | { status: "unavailable" };

export function decideIdentifyCardGate(card: {
  kind: string;
  provider: string;
  resume_id: string | null;
} | undefined): IdentifyApplyResult | null {
  if (!card) return { status: "unavailable" };
  if (card.kind !== "terminal") return { status: "unavailable" };
  if (card.resume_id) return { status: "already-set" };
  return null;
}

export function decideIdentifyApply(
  result: IdentifyResult,
  isClaimed: (id: string) => boolean,
  /**
   * Session id already held by THIS card's live PTY entry. Re-identify
   * after clearing the persisted resume must not report "claimed" for
   * our own process.
   */
  ownClaimedId?: string | null,
): IdentifyApplyResult {
  if (result.status === "error") {
    return {
      status: "error",
      source: result.source,
      message: result.message ?? "identify failed",
    };
  }
  if (result.status === "none") {
    return { status: "none", source: result.source };
  }
  if (result.status === "ambiguous") {
    return {
      status: "ambiguous",
      ids: result.ids,
      source: result.source,
      candidates: result.candidates,
    };
  }
  const id = result.ids[0];
  if (!id) return { status: "none", source: result.source };
  if (isClaimed(id) && id !== ownClaimedId) {
    return { status: "claimed", id, source: result.source };
  }
  return { status: "found", id, source: result.source, via: result.via };
}

/** Human picked one of the ambiguous candidates — same ownership gate. */
export function decideIdentifyChoiceApply(
  chooseId: string,
  allowedIds: readonly string[],
  isClaimed: (id: string) => boolean,
  ownClaimedId?: string | null,
): IdentifyApplyResult {
  if (!allowedIds.includes(chooseId)) {
    return {
      status: "error",
      source: "identify-choice",
      message: "chosen id is not among the ambiguous candidates",
    };
  }
  if (isClaimed(chooseId) && chooseId !== ownClaimedId) {
    return { status: "claimed", id: chooseId, source: "identify-choice" };
  }
  return { status: "found", id: chooseId, source: "identify-choice" };
}
