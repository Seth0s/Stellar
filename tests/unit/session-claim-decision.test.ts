import { describe, it, expect } from "vitest";
import {
  decideClaimAmongCandidates,
  decideIdentifyByProcessEvidence,
} from "../../src/main/session-claim-decision";

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

  it("N spawn-anchored owners and N fresh files, no brief/content => order pairing, LOW confidence", () => {
    const candidates = [
      { id: "f-1", timestampMs: 900 },
      { id: "f-2", timestampMs: 900 },
      { id: "f-3", timestampMs: 900 },
    ];
    const reservations = [
      { ownerId: "card-1", rearmAtMs: 100, matchStartMs: 100 },
      { ownerId: "card-2", rearmAtMs: 100, matchStartMs: 100 },
      { ownerId: "card-3", rearmAtMs: 100, matchStartMs: 100 },
    ];
    const claim = (ownerId: string) =>
      decideClaimAmongCandidates({
        candidates,
        isClaimed: noneClaimed,
        ownerId,
        reservations,
        requiresInputReservation: false,
      });
    // Sorted owners pair with sorted files, so each card gets a DISTINCT file —
    // but by ORDER, so the claim declares it is not proven ownership.
    expect(claim("card-1")).toEqual({ action: "claim", id: "f-1", confidence: "paired-by-order" });
    expect(claim("card-2")).toEqual({ action: "claim", id: "f-2", confidence: "paired-by-order" });
    expect(claim("card-3")).toEqual({ action: "claim", id: "f-3", confidence: "paired-by-order" });
  });

  it("N owners with DIFFERENT briefs: exact ownership by CONTENT, even when files are out of order", () => {
    // Files created in an order that does not match the owners' spawns.
    const candidates = [
      { id: "sess-b", timestampMs: 900, firstPrompt: "trabalhe na task B" },
      { id: "sess-c", timestampMs: 900, firstPrompt: "trabalhe na task C" },
      { id: "sess-a", timestampMs: 900, firstPrompt: "trabalhe na task A" },
    ];
    const reservations = [
      { ownerId: "card-a", rearmAtMs: 100, matchStartMs: 100, brief: "Trabalhe na task A" },
      { ownerId: "card-b", rearmAtMs: 100, matchStartMs: 100, brief: "Trabalhe na task B" },
      { ownerId: "card-c", rearmAtMs: 100, matchStartMs: 100, brief: "Trabalhe na task C" },
    ];
    const claim = (ownerId: string) =>
      decideClaimAmongCandidates({
        candidates,
        isClaimed: noneClaimed,
        ownerId,
        reservations,
        requiresInputReservation: false,
      });
    // No `confidence` field = exact: the content decided, not the order.
    expect(claim("card-a")).toEqual({ action: "claim", id: "sess-a" });
    expect(claim("card-b")).toEqual({ action: "claim", id: "sess-b" });
    expect(claim("card-c")).toEqual({ action: "claim", id: "sess-c" });
  });

  it("IDENTICAL briefs => content cannot decide, falls back to order with LOW confidence", () => {
    const candidates = [
      { id: "f-1", timestampMs: 900, firstPrompt: "mesmo brief" },
      { id: "f-2", timestampMs: 900, firstPrompt: "mesmo brief" },
    ];
    const reservations = [
      { ownerId: "card-1", rearmAtMs: 100, matchStartMs: 100, brief: "mesmo brief" },
      { ownerId: "card-2", rearmAtMs: 100, matchStartMs: 100, brief: "mesmo brief" },
    ];
    expect(
      decideClaimAmongCandidates({
        candidates,
        isClaimed: noneClaimed,
        ownerId: "card-1",
        reservations,
        requiresInputReservation: false,
      }),
    ).toEqual({ action: "claim", id: "f-1", confidence: "paired-by-order" });
  });

  it("rearm-on-input providers are NOT paired (their input times already separate them)", () => {
    expect(
      decideClaimAmongCandidates({
        candidates: [
          { id: "a", timestampMs: 900 },
          { id: "b", timestampMs: 900 },
        ],
        isClaimed: noneClaimed,
        ownerId: "card-a",
        reservations: [
          { ownerId: "card-a", rearmAtMs: 100, matchStartMs: 100 },
          { ownerId: "card-b", rearmAtMs: 100, matchStartMs: 100 },
        ],
        requiresInputReservation: true,
      }),
    ).toEqual({ action: "none", reason: "ambiguous" });
  });

  it("pairing needs a perfect matching: more files than owners still refuses", () => {
    expect(
      decideClaimAmongCandidates({
        candidates: [
          { id: "a", timestampMs: 900 },
          { id: "b", timestampMs: 900 },
        ],
        isClaimed: noneClaimed,
        ownerId: "card-a",
        reservations: [{ ownerId: "card-a", rearmAtMs: 100, matchStartMs: 100 }],
        requiresInputReservation: false,
      }),
    ).toEqual({ action: "none", reason: "ambiguous" });
  });
});

describe("decideIdentifyByProcessEvidence", () => {
  const two = [
    { id: "older", createdAtMs: 100 },
    { id: "newer", createdAtMs: 500 },
  ];

  it("exactly one candidate => unique, no process evidence needed", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: [{ id: "only" }],
        evidence: { openSessionIds: [] },
      }),
    ).toEqual({ action: "claim", id: "only", via: "unique" });
  });

  it("open fd for exactly one candidate => claim via open-fd (not mtime)", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: two,
        evidence: { openSessionIds: ["older"] },
      }),
    ).toEqual({ action: "claim", id: "older", via: "open-fd" });
  });

  it("open fd wins even when another candidate is newer", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: two,
        evidence: { openSessionIds: ["older"], processStartedAtMs: 50 },
      }),
    ).toEqual({ action: "claim", id: "older", via: "open-fd" });
  });

  it("cmdline --resume/--session-id hits exactly one => claim via cmdline", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: two,
        evidence: { openSessionIds: [], cmdlineSessionIds: ["newer"] },
      }),
    ).toEqual({ action: "claim", id: "newer", via: "cmdline" });
  });

  it("process-birth window keeps one candidate born after the process => claim", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: two,
        evidence: { openSessionIds: [], processStartedAtMs: 400 },
      }),
    ).toEqual({ action: "claim", id: "newer", via: "process-birth-window" });
  });

  it("process-birth window with TWO survivors => ambiguous, never pick by mtime", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: [
          { id: "a", createdAtMs: 450 },
          { id: "b", createdAtMs: 480 },
          { id: "old", createdAtMs: 10 },
        ],
        evidence: { openSessionIds: [], processStartedAtMs: 400 },
      }),
    ).toEqual({ action: "ambiguous", ids: ["a", "b"] });
  });

  it("no process evidence and multiple candidates => ambiguous (refusal kept)", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: two,
        evidence: { openSessionIds: [] },
      }),
    ).toEqual({ action: "ambiguous", ids: ["older", "newer"] });
  });

  it("open fd id not in candidates is ignored; falls through", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: two,
        evidence: { openSessionIds: ["foreign"] },
      }),
    ).toEqual({ action: "ambiguous", ids: ["older", "newer"] });
  });

  it("no candidates => none", () => {
    expect(
      decideIdentifyByProcessEvidence({
        candidates: [],
        evidence: { openSessionIds: ["x"] },
      }),
    ).toEqual({ action: "none" });
  });
});
