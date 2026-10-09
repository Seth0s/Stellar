import { describe, expect, it } from "vitest";
import { decideAgentStatusPill } from "../../src/renderer/src/card-footer-decision";

/**
 * Header pill must mirror `card_status` / `decideCardStatus` — never the
 * PTY byte `isActive` heuristic. A parked TUI that repaints is `unknown`
 * (or bash `unknown`), not "trabalhando".
 */
describe("decideAgentStatusPill", () => {
  it("TUI that repaints without a declared turn is NOT trabalhando", () => {
    expect(
      decideAgentStatusPill({ status: "unknown", spawnError: false, processAlive: true }).label,
    ).toBe("processo vivo");
  });

  it("active turn → trabalhando", () => {
    expect(
      decideAgentStatusPill({ status: "running", spawnError: false, processAlive: true }),
    ).toEqual({ label: "trabalhando", kind: "working", live: true, showStop: true });
  });

  it("waiting on consent → esperando você", () => {
    expect(
      decideAgentStatusPill({ status: "waiting", spawnError: false, processAlive: true }).label,
    ).toBe("esperando você");
  });

  it("idle after turn end → ocioso", () => {
    expect(
      decideAgentStatusPill({ status: "idle", spawnError: false, processAlive: true }).label,
    ).toBe("ocioso");
  });

  it("bash at prompt / unknown → processo vivo, never trabalhando", () => {
    expect(
      decideAgentStatusPill({ status: "at-prompt", spawnError: false, processAlive: true }).label,
    ).toBe("processo vivo");
    expect(
      decideAgentStatusPill({ status: null, spawnError: false, processAlive: true }).label,
    ).toBe("processo vivo");
  });

  it("spawn error and exit take precedence", () => {
    expect(
      decideAgentStatusPill({ status: "running", spawnError: true, processAlive: true }).label,
    ).toBe("erro");
    expect(
      decideAgentStatusPill({ status: "running", spawnError: false, processAlive: false }).label,
    ).toBe("saiu");
    expect(
      decideAgentStatusPill({ status: "exited", spawnError: false, processAlive: true }).label,
    ).toBe("saiu");
  });
});
