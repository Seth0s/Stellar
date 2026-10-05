import { describe, expect, it } from "vitest";
import {
  boardTaskPhaseFacts,
  deriveBoardTaskPhase,
  type BoardTaskPhaseFactsInput,
} from "../../src/main/task-phase-decision";

/**
 * The board payload's `phase` is decided in the main process from the real
 * facts the renderer used to approximate: the live reservation links, the
 * report after the last work grant, and the reviewer verdict. These are the
 * shapes `buildTaskBoard` feeds in.
 */

const facts = (over: Partial<BoardTaskPhaseFactsInput> = {}): BoardTaskPhaseFactsInput => ({
  status: "pending",
  depStatuses: [],
  liveImplementers: [],
  implementerReportAt: null,
  implementerWorkGrantedAt: null,
  reviewerChangesRequested: false,
  ...over,
});

describe("deriveBoardTaskPhase — the phase the payload carries", () => {
  it("reserved: a link held in the drawer, no active implementer", () => {
    expect(deriveBoardTaskPhase(facts({ liveImplementers: [{ reservation_state: "reserved" }] }))).toBe("reserved");
  });

  it("running: an active implementer (reservation_state null) with no report yet", () => {
    expect(deriveBoardTaskPhase(facts({ liveImplementers: [{ reservation_state: null }] }))).toBe("running");
  });

  it("awaiting_review: the implementer reported after the last work grant", () => {
    expect(
      deriveBoardTaskPhase(
        facts({
          liveImplementers: [{ reservation_state: null }],
          implementerReportAt: 5_000,
          implementerWorkGrantedAt: 4_000,
        }),
      ),
    ).toBe("awaiting_review");
  });

  it("done: the stored status is terminal, whatever else is present", () => {
    expect(
      deriveBoardTaskPhase(
        facts({
          status: "done",
          liveImplementers: [{ reservation_state: null }],
          implementerReportAt: 9_999,
          implementerWorkGrantedAt: 1,
        }),
      ),
    ).toBe("done");
  });

  it("a report older than the last work grant does NOT mean awaiting_review", () => {
    expect(
      deriveBoardTaskPhase(
        facts({
          liveImplementers: [{ reservation_state: null }],
          implementerReportAt: 3_000,
          implementerWorkGrantedAt: 4_000,
        }),
      ),
    ).toBe("running");
  });

  it("waiting_deps wins over running and reserved", () => {
    expect(
      deriveBoardTaskPhase(facts({ depStatuses: ["running"], liveImplementers: [{ reservation_state: null }] })),
    ).toBe("waiting_deps");
    expect(deriveBoardTaskPhase(facts({ depStatuses: ["done"] }))).toBe("ready");
  });

  it("changes_requested when a reviewer asked after the report", () => {
    expect(
      deriveBoardTaskPhase(
        facts({ liveImplementers: [{ reservation_state: null }], implementerReportAt: 5_000, reviewerChangesRequested: true }),
      ),
    ).toBe("changes_requested");
  });
});

describe("boardTaskPhaseFacts — shaping", () => {
  it("splits live links into active vs reserved", () => {
    const shaped = boardTaskPhaseFacts(
      facts({ liveImplementers: [{ reservation_state: null }, { reservation_state: "reserved" }] }),
    );
    expect(shaped.hasActiveImplementer).toBe(true);
    expect(shaped.hasReservedCard).toBe(true);
  });

  it("no work-grant instant means any report counts as this delivery", () => {
    expect(boardTaskPhaseFacts(facts({ implementerReportAt: 1 })).implementerReportedSinceLastDelivery).toBe(true);
    expect(boardTaskPhaseFacts(facts({ implementerReportAt: null })).implementerReportedSinceLastDelivery).toBe(false);
  });
});
