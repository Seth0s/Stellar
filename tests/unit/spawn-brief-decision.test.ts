import { describe, it, expect } from "vitest";
import { briefFromTaskPrompt, resolveSpawnBrief } from "../../src/main/spawn-brief-decision";

const lookup = (prompt: string | null | undefined) => ({
  findTask: (id: string) => (id === "t1" ? { prompt: prompt ?? null } : undefined),
});

describe("briefFromTaskPrompt", () => {
  it("devolve o prompt quando há texto", () => {
    expect(briefFromTaskPrompt("implement spawn taskId")).toBe("implement spawn taskId");
  });

  it("trimma laterais mas preserva o miolo", () => {
    expect(briefFromTaskPrompt("  keep this  ")).toBe("keep this");
  });

  it("null / undefined / vazio / só espaço → undefined (não inventa brief)", () => {
    expect(briefFromTaskPrompt(null)).toBeUndefined();
    expect(briefFromTaskPrompt(undefined)).toBeUndefined();
    expect(briefFromTaskPrompt("")).toBeUndefined();
    expect(briefFromTaskPrompt("   ")).toBeUndefined();
  });
});

describe("resolveSpawnBrief", () => {
  it("sem taskId e sem brief: válido, brief ausente (card abre mudo)", () => {
    expect(resolveSpawnBrief({}, { findTask: () => undefined })).toEqual({ ok: true, brief: undefined });
  });

  it("sem taskId, brief livre: o texto passa intacto", () => {
    expect(resolveSpawnBrief({ brief: "explore the rail" }, { findTask: () => undefined })).toEqual({
      ok: true,
      brief: "explore the rail",
    });
  });

  it("taskId de task existente: brief é o prompt dela", () => {
    expect(resolveSpawnBrief({ taskId: "t1" }, lookup("do the work"))).toEqual({
      ok: true,
      brief: "do the work",
      taskId: "t1",
    });
  });

  it("taskId inexistente: recusa nomeando o id", () => {
    const d = resolveSpawnBrief({ taskId: "missing" }, lookup("x"));
    expect(d).toEqual({ ok: false, error: 'no such task "missing"' });
  });

  it("taskId + brief juntos: recusa, não concatena nem escolhe um", () => {
    const d = resolveSpawnBrief({ taskId: "t1", brief: "and also this" }, lookup("stored prompt"));
    expect(d).toEqual({ ok: false, error: "pass taskId or brief, not both" });
  });

  it("brief vazio com taskId ainda é os dois — recusa", () => {
    expect(resolveSpawnBrief({ taskId: "t1", brief: "" }, lookup("stored"))).toEqual({
      ok: false,
      error: "pass taskId or brief, not both",
    });
  });

  it("task com prompt vazio/nulo: spawn válido, brief ausente", () => {
    expect(resolveSpawnBrief({ taskId: "t1" }, lookup(null))).toEqual({
      ok: true,
      brief: undefined,
      taskId: "t1",
    });
    expect(resolveSpawnBrief({ taskId: "t1" }, lookup(""))).toEqual({
      ok: true,
      brief: undefined,
      taskId: "t1",
    });
    expect(resolveSpawnBrief({ taskId: "t1" }, lookup("   "))).toEqual({
      ok: true,
      brief: undefined,
      taskId: "t1",
    });
  });

  it("taskId só de espaço conta como omitido — opcional de verdade", () => {
    expect(resolveSpawnBrief({ taskId: "   ", brief: "free" }, { findTask: () => undefined })).toEqual({
      ok: true,
      brief: "free",
    });
  });
});

// `role` (task_cards.role, 2026-09-13). O reviewer é a ÚNICA exceção da
// recusa taskId+brief, e pelo motivo dela, não contra: o prompt da task é
// o enunciado do trabalho, e um revisor não está sendo mandado fazer o
// trabalho — entregar o prompt a ele spawnaria um segundo implementador.
describe("resolveSpawnBrief com role", () => {
  it("role sem taskId: recusa — papel é de um card NUMA task", () => {
    expect(resolveSpawnBrief({ role: "reviewer", brief: "review it" }, { findTask: () => undefined })).toEqual({
      ok: false,
      error: 'role "reviewer" only applies together with taskId — a role is what a card does ON a task',
    });
    expect(resolveSpawnBrief({ role: "implementer" }, { findTask: () => undefined }).ok).toBe(false);
  });

  it("implementer explícito = default: brief é o prompt da task, brief junto recusado", () => {
    expect(resolveSpawnBrief({ taskId: "t1", role: "implementer" }, lookup("do the work"))).toEqual({
      ok: true,
      brief: "do the work",
      taskId: "t1",
    });
    expect(resolveSpawnBrief({ taskId: "t1", role: "implementer", brief: "extra" }, lookup("do the work"))).toEqual({
      ok: false,
      error: "pass taskId or brief, not both",
    });
  });

  it("reviewer + brief: o brief livre é a ordem de revisão, o prompt da task NÃO é entregue", () => {
    expect(resolveSpawnBrief({ taskId: "t1", role: "reviewer", brief: "review the diff of t1" }, lookup("implement X"))).toEqual({
      ok: true,
      brief: "review the diff of t1",
      taskId: "t1",
    });
  });

  it("reviewer sem brief: card abre mudo e vinculado — nunca recebe o prompt do implementador", () => {
    expect(resolveSpawnBrief({ taskId: "t1", role: "reviewer" }, lookup("implement X"))).toEqual({
      ok: true,
      brief: undefined,
      taskId: "t1",
    });
  });

  it("reviewer com taskId inexistente: recusa nomeando o id", () => {
    expect(resolveSpawnBrief({ taskId: "missing", role: "reviewer", brief: "r" }, lookup("x"))).toEqual({
      ok: false,
      error: 'no such task "missing"',
    });
  });
});
