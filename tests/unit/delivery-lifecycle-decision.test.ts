import { describe, expect, it } from "vitest";
import {
  cancelPendingFromRequester,
  decideOriginDeliveryRate,
  filterDeliveryRecords,
  ORIGIN_DELIVERY_RATE_LIMIT,
  pruneOriginDeliveryRateSamples,
  type DeliveryLifecycleRecord,
  type OriginDeliveryRateSample,
} from "../../src/main/delivery-lifecycle-decision";

function rec(partial: Partial<DeliveryLifecycleRecord> & Pick<DeliveryLifecycleRecord, "id" | "target">): DeliveryLifecycleRecord {
  return { delivery: "queued", ...partial };
}

describe("cancelPendingFromRequester", () => {
  it("cancela só queued do requester, ainda não started", () => {
    const records = [
      rec({ id: "a", target: "330", requesterId: "loop", delivery: "queued" }),
      rec({ id: "b", target: "330", requesterId: "loop", delivery: "queued", started: true }),
      rec({ id: "c", target: "330", requesterId: "other", delivery: "queued" }),
      rec({ id: "d", target: "330", delivery: "queued" }), // system — sem requester
      rec({ id: "e", target: "330", requesterId: "loop", delivery: "delivered" }),
      rec({ id: "f", target: "330", requesterId: "loop", delivery: "parked" }),
    ];
    expect(cancelPendingFromRequester({ records, requesterId: "loop" }).cancelledIds).toEqual(["a"]);
  });

  it("requester vazio não cancela nada", () => {
    const records = [rec({ id: "a", target: "t", requesterId: "x", delivery: "queued" })];
    expect(cancelPendingFromRequester({ records, requesterId: "" }).cancelledIds).toEqual([]);
  });
});

describe("decideOriginDeliveryRate", () => {
  const base: OriginDeliveryRateSample[] = [
    { requesterId: "A", target: "B", atMs: 1000 },
    { requesterId: "A", target: "B", atMs: 2000 },
    { requesterId: "A", target: "B", atMs: 3000 },
    { requesterId: "A", target: "B", atMs: 4000 },
    { requesterId: "A", target: "C", atMs: 4500 },
    { requesterId: "Z", target: "B", atMs: 4600 },
  ];

  it("permite enquanto abaixo do teto no par (requester, target)", () => {
    // 4 samples for A→B in window; 5th enqueue still allowed (count < max)
    expect(
      decideOriginDeliveryRate({
        samples: base,
        requesterId: "A",
        target: "B",
        nowMs: 5000,
      }),
    ).toEqual({ action: "allow" });
  });

  it("recusa no 6º enqueue dentro da janela (max 5)", () => {
    const five: OriginDeliveryRateSample[] = [
      ...base.filter((s) => s.requesterId === "A" && s.target === "B"),
      { requesterId: "A", target: "B", atMs: 4800 },
    ];
    expect(five).toHaveLength(ORIGIN_DELIVERY_RATE_LIMIT.max);
    const decision = decideOriginDeliveryRate({
      samples: five,
      requesterId: "A",
      target: "B",
      nowMs: 5000,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action === "refuse") {
      expect(decision.countInWindow).toBe(5);
      expect(decision.error).toMatch(/rate limit/);
    }
  });

  it("janela deslizante esquece amostras velhas", () => {
    const samples: OriginDeliveryRateSample[] = Array.from({ length: 5 }, (_, i) => ({
      requesterId: "A",
      target: "B",
      atMs: i * 100,
    }));
    expect(
      decideOriginDeliveryRate({
        samples,
        requesterId: "A",
        target: "B",
        nowMs: ORIGIN_DELIVERY_RATE_LIMIT.windowMs + 500,
      }),
    ).toEqual({ action: "allow" });
  });
});

describe("pruneOriginDeliveryRateSamples", () => {
  it("corta o que caiu fora da janela", () => {
    const samples: OriginDeliveryRateSample[] = [
      { requesterId: "A", target: "B", atMs: 1 },
      { requesterId: "A", target: "B", atMs: 10_000 },
    ];
    expect(pruneOriginDeliveryRateSamples(samples, 10_500, 10_000)).toEqual([
      { requesterId: "A", target: "B", atMs: 10_000 },
    ]);
  });
});

describe("filterDeliveryRecords", () => {
  const records = [
    rec({ id: "1", target: "t1", requesterId: "r1", delivery: "queued" }),
    rec({ id: "2", target: "t1", requesterId: "r2", delivery: "queued" }),
    rec({ id: "3", target: "t2", requesterId: "r1", delivery: "delivered" }),
  ];

  it("filtra por requester + delivery", () => {
    expect(filterDeliveryRecords(records, { requesterId: "r1", delivery: "queued" }).map((r) => r.id)).toEqual([
      "1",
    ]);
  });

  it("filtra por target", () => {
    expect(filterDeliveryRecords(records, { target: "t1" }).map((r) => r.id)).toEqual(["1", "2"]);
  });
});
