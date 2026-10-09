import { describe, expect, it } from "vitest";
import {
  activeDeclarationCardIds,
  filterActiveDeclaredFiles,
} from "../../src/main/active-declaration-decision";
import { decideGateIsolation } from "../../src/main/gate-isolation-decision";
import { isTerminalStatus } from "../../src/task-status-derive";

/**
 * Gate-isolation dispute must cite only ACTIVE writers. Measured case:
 * one live card + archived + missing cards all declared the same path; the
 * shared-mode note listed every ghost id.
 */

const PATH = "src/main/message-bus.ts";
const ALIVE = "98576332";
const ARCHIVED = ["97924184", "97924189", "98576196", "98576214", "98576217"] as const;
const MISSING = ["97924109", "97924149", "97924155"] as const;
const DEAD = [...ARCHIVED, ...MISSING];

describe("activeDeclarationCardIds", () => {
  it("measured case: 1 live + archived + missing → only the live card", () => {
    const aliveSet = new Set([ALIVE]);
    const tasks = [
      {
        status: "pending",
        cardId: ALIVE,
        liveImplementers: [{ cardId: ALIVE, reservationState: null }],
      },
      ...ARCHIVED.map((cardId) => ({
        status: "pending",
        cardId,
        liveImplementers: [{ cardId, reservationState: null }],
      })),
      ...MISSING.map((cardId) => ({
        status: "pending",
        cardId,
        liveImplementers: [{ cardId, reservationState: null }],
      })),
    ];
    const ids = activeDeclarationCardIds({
      tasks,
      isTerminalStatus,
      isCardAlive: (id) => aliveSet.has(id),
    });
    expect(ids).toEqual([ALIVE]);
  });

  it("drops terminal tasks even when the card is still alive", () => {
    const ids = activeDeclarationCardIds({
      tasks: [
        {
          status: "done",
          cardId: "done-card",
          liveImplementers: [{ cardId: "done-card", reservationState: null }],
        },
        {
          status: "pending",
          cardId: "live",
          liveImplementers: [{ cardId: "live", reservationState: null }],
        },
      ],
      isTerminalStatus,
      isCardAlive: () => true,
    });
    expect(ids).toEqual(["live"]);
  });

  it("reservation-only links are not executing writers", () => {
    const ids = activeDeclarationCardIds({
      tasks: [
        {
          status: "pending",
          cardId: "reserved",
          liveImplementers: [{ cardId: "reserved", reservationState: "reserved" }],
        },
      ],
      isTerminalStatus,
      isCardAlive: () => true,
    });
    expect(ids).toEqual([]);
  });

  it("legacy principal card_id with no task_cards rows still counts when alive", () => {
    const ids = activeDeclarationCardIds({
      tasks: [{ status: "pending", cardId: "legacy", liveImplementers: [] }],
      isTerminalStatus,
      isCardAlive: (id) => id === "legacy",
    });
    expect(ids).toEqual(["legacy"]);
  });
});

describe("filter + decideGateIsolation (acceptance)", () => {
  it("without filter the measured mix disputes; with filter only the live card → isolated", () => {
    const declared = [
      { cardId: ALIVE, paths: [PATH] },
      ...DEAD.map((cardId) => ({ cardId, paths: [PATH] })),
    ];
    const buggy = decideGateIsolation({ cardId: ALIVE, declared, gitRoot: "/repo" });
    expect(buggy.mode).toBe("shared");
    expect(buggy.disputed[0]?.cardIds).toEqual(expect.arrayContaining([ALIVE, ...DEAD]));
    expect(buggy.disputed[0]?.cardIds).toHaveLength(1 + DEAD.length);

    const filtered = filterActiveDeclaredFiles(declared, [ALIVE]);
    const fixed = decideGateIsolation({ cardId: ALIVE, declared: filtered, gitRoot: "/repo" });
    expect(fixed.mode).toBe("isolated");
    expect(fixed.disputed).toEqual([]);
    expect(fixed.files).toEqual([PATH]);
  });

  it("two live cards declaring the same file still dispute", () => {
    const declared = [
      { cardId: "live-a", paths: [PATH] },
      { cardId: "live-b", paths: [PATH] },
    ];
    const d = decideGateIsolation({ cardId: "live-a", declared, gitRoot: "/repo" });
    expect(d.mode).toBe("shared");
    expect(d.disputed).toEqual([{ path: PATH, cardIds: ["live-a", "live-b"] }]);
    expect(d.reason).toMatch(/live-a, live-b/);
  });
});
