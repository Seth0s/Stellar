import { describe, expect, it } from "vitest";
import {
  filterListedTasks,
  gateRunSummaryFromResult,
  parseListTasksQuery,
  projectListedTask,
  taskTitle,
  type ListedTask,
} from "../../src/main/list-tasks-query";

/**
 * Task 6266d3e7 — list_tasks: filtros novos (phase/ids/sprintId/boardId/cardId/
 * limit/cursor), default `summary`, e o resumo do gateRun.
 */

function listed(id: string, over: Partial<ListedTask> = {}): ListedTask {
  return {
    id,
    prompt: `title of ${id}`,
    provider: "commandcode",
    status: "pending",
    cardAlive: false,
    cardId: null,
    boardId: "b1",
    cwd: null,
    purpose: null,
    review: null,
    territory: null,
    gates: null,
    allowCommit: null,
    reportSchema: null,
    result: null,
    deps: null,
    retryCount: 0,
    attemptedProviders: null,
    maxRetries: 0,
    fallbackProviders: null,
    order: null,
    suggestedOrder: null,
    createdAt: 1,
    updatedAt: 1,
    divergedStatus: null,
    divergedActor: null,
    requestedStatus: null,
    requestedReason: null,
    requestedBy: null,
    requestedAt: null,
    sprintId: null,
    ...over,
  };
}

describe("parseListTasksQuery — novos filtros e default summary", () => {
  it("default = summary", () => {
    const p = parseListTasksQuery({});
    expect(p.ok && p.view).toBe("summary");
  });

  it("phase string ou lista; lista vazia recusada", () => {
    const p = parseListTasksQuery({ phase: ["awaiting_review", "running"] });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.phaseSet?.has("awaiting_review")).toBe(true);
    expect(parseListTasksQuery({ phase: [] }).ok).toBe(false);
  });

  it("ids, boardId, cardId, sprintId, limit, cursor", () => {
    const p = parseListTasksQuery({ ids: ["0871b484"], boardId: "b1", cardId: "c1", sprintId: "s1", limit: 10, cursor: 0 });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.ids).toEqual(["0871b484"]);
      expect(p.boardId).toBe("b1");
      expect(p.limit).toBe(10);
      expect(p.cursor).toBe(0);
    }
    expect(parseListTasksQuery({ limit: 0 }).ok).toBe(false);
    expect(parseListTasksQuery({ cursor: -1 }).ok).toBe(false);
  });
});

describe("filterListedTasks — phase e ids (prefixo)", () => {
  it("filtra por phase", () => {
    const tasks = [listed("a", { phase: "running" }), listed("b", { phase: "awaiting_review" })];
    const parsed = parseListTasksQuery({ phase: "awaiting_review" });
    if (!parsed.ok) throw new Error("parse");
    expect(filterListedTasks(tasks, parsed, new Set()).map((t) => t.id)).toEqual(["b"]);
  });

  it("ids aceita PREFIXO (startsWith)", () => {
    const tasks = [listed("0871b484-aaaa"), listed("deadbeef-0000")];
    const parsed = parseListTasksQuery({ ids: ["0871b484"] });
    if (!parsed.ok) throw new Error("parse");
    expect(filterListedTasks(tasks, parsed, new Set()).map((t) => t.id)).toEqual(["0871b484-aaaa"]);
  });
});

describe("gateRunSummaryFromResult", () => {
  it("resume ok e N/M verdes, e nomeia o comando que falhou", () => {
    expect(
      gateRunSummaryFromResult({ gateRun: { ok: false, commands: [{ command: "a", exitCode: 0 }, { command: "tsc", exitCode: 2 }] } }),
    ).toEqual({ ok: false, passed: 1, total: 2, failedCommand: "tsc" });
  });
  it("ausência de gateRun → null (ausência é dado)", () => {
    expect(gateRunSummaryFromResult(null)).toBeNull();
    expect(gateRunSummaryFromResult({})).toBeNull();
    expect(gateRunSummaryFromResult({ gateRun: { ok: true } })).toBeNull();
  });
});

describe("taskTitle + projectListedTask summary", () => {
  it("título é a primeira linha não-vazia", () => {
    expect(taskTitle("\n\n  Consertar o push  \nresto")).toBe("Consertar o push");
  });
  it("summary mantém phase/title/gateRun e derruba prompt/result", () => {
    const t = listed("a", { phase: "running", title: "T", gateRun: { ok: true, passed: 2, total: 2, failedCommand: null } });
    const out = projectListedTask(t, "summary") as Record<string, unknown>;
    expect(out.phase).toBe("running");
    expect(out.title).toBe("T");
    expect(out.gateRun).toEqual({ ok: true, passed: 2, total: 2, failedCommand: null });
    expect("prompt" in out).toBe(false);
    expect("result" in out).toBe(false);
  });
});
