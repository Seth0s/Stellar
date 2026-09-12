import { describe, it, expect } from "vitest";
import {
  decideFailureKind,
  decideFailureWrite,
  stampFailureKindJson,
  failureKindFromResultJson,
  interruptionReasonFromResultJson,
} from "../../src/main/failure-kind-decision";
import { bucketForStatus, decideSprintClose } from "../../src/main/sprint-close-decision";

describe("decideFailureKind / decideFailureWrite", () => {
  it("saída sem report → interrompida → pending", () => {
    expect(decideFailureKind("exit_without_report")).toBe("interrompida");
    expect(decideFailureWrite("interrompida")).toEqual({ status: "pending", failureKind: "interrompida" });
  });

  it("failed explícito (agente/humano) → julgada → failed", () => {
    expect(decideFailureKind("explicit_failed")).toBe("julgada");
    expect(decideFailureWrite("julgada")).toEqual({ status: "failed", failureKind: "julgada" });
  });
});

describe("result_json helpers", () => {
  it("stampFailureKindJson preserva error e grava failureKind", () => {
    expect(JSON.parse(stampFailureKindJson(null, "interrompida", "card died"))).toEqual({
      failureKind: "interrompida",
      error: "card died",
    });
    expect(JSON.parse(stampFailureKindJson('{"error":"old","x":1}', "julgada"))).toEqual({
      error: "old",
      x: 1,
      failureKind: "julgada",
    });
  });

  it("failureKindFromResultJson / interruptionReasonFromResultJson", () => {
    expect(failureKindFromResultJson(null)).toBeNull();
    expect(failureKindFromResultJson('{"failureKind":"julgada"}')).toBe("julgada");
    expect(interruptionReasonFromResultJson('{"failureKind":"interrompida","error":"exit 129"}')).toBe("exit 129");
    expect(interruptionReasonFromResultJson('{"failureKind":"julgada","error":"nope"}')).toBeNull();
  });
});

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

describe("decideSprintClose — falha tipada", () => {
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

  it("julgada (failed default) conta em failed e NÃO migra; todo/doing migram", () => {
    const decision = decideSprintClose([
      { id: "a", status: "pending" },
      { id: "b", status: "running" },
      { id: "c", status: "done" },
      { id: "d", status: "failed" },
      { id: "e", status: "failed", failureKind: "julgada" },
    ]);
    expect(decision).toEqual({
      countTodo: 1,
      countDoing: 1,
      countDone: 1,
      countFailed: 2,
      migrateIds: ["a", "b"],
      migratedOut: 2,
    });
  });

  it("interrompida migra como todo e NÃO conta como falha no snapshot", () => {
    const decision = decideSprintClose([
      { id: "j", status: "failed", failureKind: "julgada" },
      { id: "i", status: "failed", failureKind: "interrompida" },
      { id: "t", status: "pending" },
    ]);
    expect(decision.countFailed).toBe(1);
    expect(decision.countTodo).toBe(2); // pending + interrompida
    expect(decision.migrateIds).toEqual(["i", "t"]);
    expect(decision.migratedOut).toBe(2);
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
