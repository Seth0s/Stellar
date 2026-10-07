import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";

/**
 * Closing a card releases its link to a task as a SIDE EFFECT (`keepStatus`),
 * and that must never rewrite the task's status. Measured: a task already
 * `done`, approved in two review rounds, went back to `pending` (author: the
 * card that asked for the close) when its implementer's card was closed with
 * `releaseReservations`. The explicit `release_task_card` keeps its own
 * behaviour — a deliberate decision that returns an orphaned open task (or a
 * failed one, for a retry) to `pending` — and is pinned in
 * task-card-release-gate-scope.test.ts.
 */
function baseTask(id: string, over: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: `prompt of ${id}`,
    provider: "claude",
    status: "pending",
    card_id: null,
    board_id: "board-a",
    cwd: null,
    result_json: null,
    deps_json: null,
    retry_count: 0,
    attempted_providers_json: null,
    max_retries: null,
    fallback_providers_json: null,
    order: null,
    suggested_order: null,
    implicit_order: null,
    diverged_status: null,
    diverged_actor: null,
    created_at: now,
    updated_at: now,
    ...over,
  } as TaskRow;
}

describe("store: releasing a card link and the task status", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(status: string) {
    dir = mkdtempSync(join(tmpdir(), "release-terminal-"));
    const store = openStore(dir);
    store.upsertTask(baseTask("t1", { card_id: "impl", status }));
    store.linkTaskCard("t1", "impl", "implementer");
    return store;
  }
  const release = (store: ReturnType<typeof setup>, keepStatus = true) =>
    store.releaseTaskCardFromTask({
      taskId: "t1",
      cardId: "impl",
      reason: "card closed",
      releasedBy: "orchestrator-card",
      actor: "agent",
      keepStatus,
    });

  it.each(["done", "failed", "superseded"])("a %s task keeps its status; the link is released and the pointer cleared", (status) => {
    const store = setup(status);
    const res = release(store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.liveImplementersLeft).toBe(0);
    expect(res.taskStatus).toBe(status);
    expect(store.getTask("t1")?.status).toBe(status);
    expect(store.getTask("t1")?.card_id).toBeNull();
    // Nothing was written to the task's status trail by the release.
    const trail = store.getTaskTransitions("t1");
    expect(trail.length).toBeGreaterThan(0); // the accessor is real: the creation is on the trail
    expect(trail.filter((t) => t.kind === "status" && t.to_value === "pending" && t.from_value === status)).toEqual([]);
  });

  it("an open task keeps its status too (nothing is decided about it by a close)", () => {
    const store = setup("pending");
    const res = release(store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.taskStatus).toBe("pending");
    expect(store.getTask("t1")?.card_id).toBeNull();
    expect(store.getTaskTransitions("t1").filter((t) => t.kind === "status" && t.to_value === "pending" && t.from_value === "pending")).toEqual([]);
  });

  it("WITHOUT keepStatus the explicit release is unchanged: a failed task goes back to pending for a retry", () => {
    const store = setup("failed");
    const res = release(store, false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.taskStatus).toBe("pending");
  });
});
