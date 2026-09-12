import { describe, it, expect } from "vitest";
import { bucketForStatus, decideSprintClose } from "../../src/main/sprint-close-decision";

/** Thin re-export coverage — detailed falha-tipada cases live in
 * failure-kind-decision.test.ts (same decideSprintClose). */
describe("decideSprintClose (smoke)", () => {
  it("bucketForStatus cobre o mapa conhecido", () => {
    expect(bucketForStatus("pending")).toBe("todo");
    expect(bucketForStatus("failed")).toBe("failed");
  });

  it("failed sem kind = julgada (não migra, conta)", () => {
    expect(decideSprintClose([{ id: "f", status: "failed" }])).toEqual({
      countTodo: 0,
      countDoing: 0,
      countDone: 0,
      countFailed: 1,
      migrateIds: [],
      migratedOut: 0,
    });
  });
});
