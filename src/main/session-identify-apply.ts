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
  | { status: "found"; id: string; source: string }
  | { status: "ambiguous"; ids: string[]; source: string }
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
    return { status: "ambiguous", ids: result.ids, source: result.source };
  }
  const id = result.ids[0];
  if (!id) return { status: "none", source: result.source };
  if (isClaimed(id)) return { status: "claimed", id, source: result.source };
  return { status: "found", id, source: result.source };
}
