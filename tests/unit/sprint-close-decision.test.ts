import { describe, it, expect } from "vitest";
import { bucketForStatus, decideSprintClose } from "../../src/main/sprint-close-decision";

describe("bucketForStatus", () => {
  it("mapeia os quatro status conhecidos", () => {
    expect(bucketForStatus("pending")).toBe("todo");
    expect(bucketForStatus("running")).toBe("doing");
    expect(bucketForStatus("done")).toBe("done");
    expect(bucketForStatus("failed")).toBe("failed");
  });

  it("status desconhecido cai em todo (mesmo fallback do quadro)", () => {
    expect(bucketForStatus("weird")).toBe("todo");
  });
});

describe("decideSprintClose", () => {
  it("fila vazia: snapshot zerado, nada migra (store recusa o close)", () => {
    expect(decideSprintClose([])).toEqual({
      countTodo: 0,
      countDoing: 0,
      countDone: 0,
      countFailed: 0,
      migrateIds: [],
      migratedOut: 0,
    });
  });

  it("conta cada bucket; migra só todo/doing; done e failed NÃO migram", () => {
    const decision = decideSprintClose([
      { id: "a", status: "pending" },
      { id: "b", status: "running" },
      { id: "c", status: "done" },
      { id: "d", status: "failed" },
      { id: "e", status: "pending" },
    ]);
    expect(decision).toEqual({
      countTodo: 2,
      countDoing: 1,
      countDone: 1,
      countFailed: 1,
      migrateIds: ["a", "b", "e"],
      migratedOut: 3,
    });
  });

  it("failed NÃO migra (decisão fechada: documentada no sprint onde falhou)", () => {
    const decision = decideSprintClose([{ id: "f", status: "failed" }]);
    expect(decision.countFailed).toBe(1);
    expect(decision.migrateIds).toEqual([]);
    expect(decision.migratedOut).toBe(0);
  });

  it("status desconhecido conta como todo e migra", () => {
    const decision = decideSprintClose([{ id: "x", status: "blocked" }]);
    expect(decision.countTodo).toBe(1);
    expect(decision.migrateIds).toEqual(["x"]);
  });

  it("só done: snapshot com concluídas, migratedOut 0", () => {
    const decision = decideSprintClose([
      { id: "1", status: "done" },
      { id: "2", status: "done" },
    ]);
    expect(decision).toEqual({
      countTodo: 0,
      countDoing: 0,
      countDone: 2,
      countFailed: 0,
      migrateIds: [],
      migratedOut: 0,
    });
  });
});
