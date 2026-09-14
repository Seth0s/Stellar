import { describe, it, expect } from "vitest";
import {
  filterListedTasks,
  parseListTasksQuery,
  projectListedTask,
  type ListedTask,
} from "../../src/main/list-tasks-query";

function task(partial: Partial<ListedTask> & Pick<ListedTask, "id" | "status">): ListedTask {
  return {
    prompt: "long prompt ".repeat(20),
    provider: "claude",
    cardId: null,
    boardId: "64",
    cwd: null,
    purpose: null,
    result: { bulky: true },
    deps: [],
    retryCount: 0,
    attemptedProviders: [],
    maxRetries: 2,
    fallbackProviders: [],
    order: null,
    suggestedOrder: null,
    createdAt: 1000,
    updatedAt: 2000,
    divergedStatus: null,
    divergedActor: null,
    requestedStatus: null,
    requestedReason: null,
    requestedBy: null,
    requestedAt: null,
    sprintId: null,
    ...partial,
  };
}

describe("parseListTasksQuery", () => {
  it("omitido = full, sem filtros", () => {
    expect(parseListTasksQuery({})).toEqual({ ok: true, view: "full" });
  });

  it("status aceita string ou lista; lista vazia é recusada", () => {
    const one = parseListTasksQuery({ status: "pending" });
    expect(one.ok).toBe(true);
    if (one.ok) expect([...one.statusSet!]).toEqual(["pending"]);

    const many = parseListTasksQuery({ status: ["pending", "running"] });
    expect(many.ok).toBe(true);
    if (many.ok) expect(many.statusSet).toEqual(new Set(["pending", "running"]));

    expect(parseListTasksQuery({ status: [] })).toEqual({
      ok: false,
      error: expect.stringMatching(/empty/),
    });
  });

  it("view desconhecida e since/hasCard mal tipados são recusados", () => {
    expect(parseListTasksQuery({ view: "tiny" }).ok).toBe(false);
    expect(parseListTasksQuery({ since: "yesterday" }).ok).toBe(false);
    expect(parseListTasksQuery({ hasCard: "yes" }).ok).toBe(false);
  });
});

describe("filterListedTasks + projectListedTask", () => {
  const rows = [
    task({ id: "a", status: "pending", cardId: "10", updatedAt: 100 }),
    task({ id: "b", status: "pending", cardId: "99", updatedAt: 200 }), // card gone
    task({ id: "c", status: "pending", cardId: null, updatedAt: 300 }),
    task({ id: "d", status: "running", cardId: "11", updatedAt: 400 }),
    task({ id: "e", status: "done", cardId: "10", updatedAt: 500 }),
  ];
  const alive = new Set(["10", "11"]);

  it("status + hasCard responde 'pending com card vivo'", () => {
    const parsed = parseListTasksQuery({ status: "pending", hasCard: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = filterListedTasks(rows, parsed, alive);
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });

  it("hasCard:false pega pending sem card vivo (null ou morto)", () => {
    const parsed = parseListTasksQuery({ status: "pending", hasCard: false });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(filterListedTasks(rows, parsed, alive).map((t) => t.id).sort()).toEqual(["b", "c"]);
  });

  it("since corta por updatedAt", () => {
    const parsed = parseListTasksQuery({ since: 300 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(filterListedTasks(rows, parsed, alive).map((t) => t.id).sort()).toEqual(["c", "d", "e"]);
  });

  it("summary remove prompt e result; full preserva", () => {
    const row = rows[0]!;
    const full = projectListedTask(row, "full");
    expect(full).toHaveProperty("prompt");
    expect(full).toHaveProperty("result");

    const summary = projectListedTask(row, "summary");
    expect(summary).not.toHaveProperty("prompt");
    expect(summary).not.toHaveProperty("result");
    expect(summary).toMatchObject({ id: "a", status: "pending", cardId: "10", boardId: "64" });
  });
});
