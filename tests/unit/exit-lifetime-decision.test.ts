import { describe, it, expect } from "vitest";
import {
  INSTANT_EXIT_LIFETIME_MS,
  decideExitWithoutReportWrite,
  describeInstantExitDiagnosis,
} from "../../src/main/exit-lifetime-decision";

const baseError = "process exited (code 129) without ever calling report";

describe("exit-lifetime-decision — lifetime floor (not backoff)", () => {
  it("N is the measured 15:50 cluster ceiling (12s) plus margin — 30s", () => {
    expect(INSTANT_EXIT_LIFETIME_MS).toBe(30_000);
  });

  it("instant death (4s / 12s — measured) → failed + julgada diagnosis, not pending", () => {
    for (const ms of [4_000, 5_000, 12_000, INSTANT_EXIT_LIFETIME_MS - 1]) {
      const d = decideExitWithoutReportWrite({ lifetimeMs: ms, exitError: baseError });
      expect(d.instant).toBe(true);
      expect(d.status).toBe("failed");
      expect(d.failureKind).toBe("julgada");
      expect(d.error).toContain("launch diagnosis");
      expect(d.error).toContain(baseError);
      expect(d.error).toBe(describeInstantExitDiagnosis(ms, baseError));
    }
  });

  it("at-or-above floor → interrompida pending (retryable interruption path)", () => {
    for (const ms of [INSTANT_EXIT_LIFETIME_MS, 60_000, 36 * 60_000]) {
      const d = decideExitWithoutReportWrite({ lifetimeMs: ms, exitError: baseError });
      expect(d.instant).toBe(false);
      expect(d.status).toBe("pending");
      expect(d.failureKind).toBe("interrompida");
      expect(d.error).toBe(baseError);
    }
  });

  it("unknown lifetime → same as long-lived (no false failed after restart)", () => {
    const d = decideExitWithoutReportWrite({ lifetimeMs: null, exitError: baseError });
    expect(d.instant).toBe(false);
    expect(d.status).toBe("pending");
    expect(d.failureKind).toBe("interrompida");
  });
});
