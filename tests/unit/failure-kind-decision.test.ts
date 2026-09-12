import { describe, it, expect } from "vitest";
import {
  decideFailureKind,
  decideFailureWrite,
  resolveFailureKind,
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

  it("spawn_failed / retry_spawn_failed defaultam interrompida (causas distintas de exit_without_report)", () => {
    expect(decideFailureKind("spawn_failed")).toBe("interrompida");
    expect(decideFailureKind("retry_spawn_failed")).toBe("interrompida");
  });
});

describe("resolveFailureKind — julgada nunca rebaixa", () => {
  it("sem kind prévio: segue a causa", () => {
    expect(resolveFailureKind(null, "exit_without_report")).toBe("interrompida");
    expect(resolveFailureKind(null, "retry_spawn_failed")).toBe("interrompida");
    expect(resolveFailureKind(undefined, "explicit_failed")).toBe("julgada");
  });

  it("julgada existente sobrevive a retry_spawn_failed (o bug grave)", () => {
    expect(resolveFailureKind("julgada", "retry_spawn_failed")).toBe("julgada");
    expect(resolveFailureKind("julgada", "spawn_failed")).toBe("julgada");
    expect(resolveFailureKind("julgada", "exit_without_report")).toBe("julgada");
  });

  it("interrompida existente pode permanecer interrompida em nova causa infra", () => {
    expect(resolveFailureKind("interrompida", "retry_spawn_failed")).toBe("interrompida");
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

describe("decideSprintClose — falha tipada (via status já escrito)", () => {
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

  it("failed (=julgada na escrita) conta e NÃO migra; pending interrompida migra como todo", () => {
    const decision = decideSprintClose([
      { id: "a", status: "pending" }, // inclui interrompida já reescrita
      { id: "b", status: "running" },
      { id: "c", status: "done" },
      { id: "d", status: "failed" },
    ]);
    expect(decision).toEqual({
      countTodo: 1,
      countDoing: 1,
      countDone: 1,
      countFailed: 1,
      migrateIds: ["a", "b"],
      migratedOut: 2,
    });
  });

  it("status desconhecido conta como todo e migra", () => {
    const decision = decideSprintClose([{ id: "x", status: "blocked" }]);
    expect(decision.countTodo).toBe(1);
    expect(decision.migrateIds).toEqual(["x"]);
  });
});
