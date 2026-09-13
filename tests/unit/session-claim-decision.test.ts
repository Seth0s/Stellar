import { describe, it, expect } from "vitest";
import { decideClaimAmongCandidates } from "../../src/main/session-claim-decision";

const noneClaimed = () => false;

describe("decideClaimAmongCandidates", () => {
  it("no open candidates => no-candidates", () => {
    expect(
      decideClaimAmongCandidates({
        candidates: [{ id: "taken" }],
        isClaimed: () => true,
        reservations: [],
        requiresInputReservation: false,
      }),
    ).toEqual({ action: "none", reason: "no-candidates" });
  });

  it("codex-style: exactly one unowned candidate, no reservations => claim it", () => {
    expect(
      decideClaimAmongCandidates({
        candidates: [{ id: "only", timestampMs: 10 }],
        isClaimed: noneClaimed,
        reservations: [],
        requiresInputReservation: false,
      }),
    ).toEqual({ action: "claim", id: "only" });
  });

  it("two unowned candidates and no way to distinguish => ambiguous, NEVER pick by mtime", () => {
    const newer = { id: "newer", timestampMs: 200 };
    const older = { id: "older", timestampMs: 100 };
    expect(
      decideClaimAmongCandidates({
        candidates: [newer, older],
        isClaimed: noneClaimed,
        reservations: [],
        requiresInputReservation: false,
      }),
    ).toEqual({ action: "none", reason: "ambiguous" });
  });

  it("rearm-on-input provider without a reservation => awaiting-input (do not steal a sibling's file)", () => {
    expect(
      decideClaimAmongCandidates({
        candidates: [{ id: "sibling", timestampMs: 50 }],
        isClaimed: noneClaimed,
        ownerId: "card-a",
        reservations: [],
        requiresInputReservation: true,
      }),
    ).toEqual({ action: "none", reason: "awaiting-input" });
  });

  it("two cards typed; one file after the later input => awarded to the later card, not the older watcher", () => {
    const file = { id: "sess", timestampMs: 300 };
    const reservations = [
      { ownerId: "card-first", rearmAtMs: 100, matchStartMs: 100 },
      { ownerId: "card-second", rearmAtMs: 200, matchStartMs: 200 },
    ];
    expect(
      decideClaimAmongCandidates({
        candidates: [file],
        isClaimed: noneClaimed,
        ownerId: "card-second",
        reservations,
        requiresInputReservation: true,
      }),
    ).toEqual({ action: "claim", id: "sess" });
    expect(
      decideClaimAmongCandidates({
        candidates: [file],
        isClaimed: noneClaimed,
        ownerId: "card-first",
        reservations,
        requiresInputReservation: true,
      }),
    ).toEqual({ action: "none", reason: "not-ours" });
  });

  it("two files after the same card's input => ambiguous, do not pick newer mtime", () => {
    expect(
      decideClaimAmongCandidates({
        candidates: [
          { id: "a", timestampMs: 150 },
          { id: "b", timestampMs: 180 },
        ],
        isClaimed: noneClaimed,
        ownerId: "card-a",
        reservations: [{ ownerId: "card-a", rearmAtMs: 100, matchStartMs: 100 }],
        requiresInputReservation: true,
      }),
    ).toEqual({ action: "none", reason: "ambiguous" });
  });

  it("two owners with the same rearm timestamp matching one file => tie, ambiguous", () => {
    expect(
      decideClaimAmongCandidates({
        candidates: [{ id: "sess", timestampMs: 50 }],
        isClaimed: noneClaimed,
        ownerId: "card-a",
        reservations: [
          { ownerId: "card-a", rearmAtMs: 10, matchStartMs: 10 },
          { ownerId: "card-b", rearmAtMs: 10, matchStartMs: 10 },
        ],
        requiresInputReservation: true,
      }),
    ).toEqual({ action: "none", reason: "ambiguous" });
  });
});
