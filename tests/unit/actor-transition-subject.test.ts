/**
 * Subject on task_transitions — stop throwing away requesterId.
 * Measured 2026-09-14: setStatusAsk already stamped requester on
 * kind:'request'; upsertTask wrote tasks.card_id (implementer) or null.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type TaskRow } from "../../src/main/store";

function base(id: string, extra: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "p",
    provider: null,
    status: "pending",
    card_id: null,
    board_id: "b1",
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
    actor: "agent",
    ...extra,
  };
}

describe("actor transition subject (actorCardId)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stamps requester on status transition when actorCardId is set (even if task has no card)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-actor-subj-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { actorCardId: "416", card_id: null }));
      const status = store.getTask("t1")!.transitions!.find((t) => t.kind === "status");
      expect(status?.actor).toBe("agent");
      expect(status?.card_id).toBe("416");
    } finally {
      store.close();
    }
  });

  it("prefers actorCardId over the task implementer card_id", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-actor-subj-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t2", { card_id: "99", actorCardId: "416" }));
      const status = store.getTask("t2")!.transitions!.find((t) => t.kind === "status");
      expect(status?.card_id).toBe("416");
    } finally {
      store.close();
    }
  });

  it("legacy omit keeps task.card_id fallback (app/human paths)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-actor-subj-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t3", { card_id: "99", actor: "app" }));
      const status = store.getTask("t3")!.transitions!.find((t) => t.kind === "status");
      expect(status?.card_id).toBe("99");
    } finally {
      store.close();
    }
  });

  it("explicit null actorCardId records honest anonymity (does not fall back to implementer)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-actor-subj-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t4", { card_id: "99", actorCardId: null }));
      const status = store.getTask("t4")!.transitions!.find((t) => t.kind === "status");
      expect(status?.card_id).toBeNull();
    } finally {
      store.close();
    }
  });
});
