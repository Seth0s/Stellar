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
  implementerReportedSinceLastDelivery: false,
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

  it("awaiting_review: the caller already decided this task was delivered", () => {
    expect(
      deriveBoardTaskPhase(
        facts({
          liveImplementers: [{ reservation_state: null }],
          implementerReportedSinceLastDelivery: true,
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
          implementerReportedSinceLastDelivery: true,
        }),
      ),
    ).toBe("done");
  });

  it("a delivery the caller did not accept stays running", () => {
    expect(
      deriveBoardTaskPhase(
        facts({
          liveImplementers: [{ reservation_state: null }],
          implementerReportedSinceLastDelivery: false,
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
        facts({ liveImplementers: [{ reservation_state: null }], implementerReportedSinceLastDelivery: true, reviewerChangesRequested: true }),
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

  it("passes the caller's delivery bit through unchanged", () => {
    expect(boardTaskPhaseFacts(facts({ implementerReportedSinceLastDelivery: true })).implementerReportedSinceLastDelivery).toBe(true);
    expect(boardTaskPhaseFacts(facts({ implementerReportedSinceLastDelivery: false })).implementerReportedSinceLastDelivery).toBe(false);
  });
});
