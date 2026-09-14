import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type BoardRow, type TaskRow } from "../../src/main/store";

function makeBoard(id: string): BoardRow {
  const now = Date.now();
  return {
    id,
    name: `Board ${id}`,
    project: "",
    cwd: "",
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    autonomous: false,
    concurrency_cap: null,
  };
}
import { deriveTaskStatus } from "../../src/task-status-derive";

describe("task-status-derive + store (CAMADA 3)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function base(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
    const now = Date.now();
    return {
      id,
      prompt: "faz X",
      provider: "claude",
      status: "pending",
      card_id: null,
      board_id: "default",
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
      ...overrides,
    };
  }

  it("coerce running → pending on write", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-coerce-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { status: "running", actor: "agent" }));
      expect(store.getTask("t1")!.status).toBe("pending");
    } finally {
      store.close();
    }
  });

  it("live card_id → derived running (manual link)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-live-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { actor: "agent" }));
      store.upsertTask(
        base("t1", { card_id: "card-a", status: "pending", actor: "agent", statusProposed: false, updated_at: Date.now() + 1 }),
      );
      const row = store.getTask("t1")!;
      expect(deriveTaskStatus(row.status, true)).toBe("running");
    } finally {
      store.close();
    }
  });

  it("dead card → derived pending after restart (no alive)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-dead-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { actor: "agent" }));
      store.upsertTask(base("t1", { card_id: "card-a", actor: "agent", statusProposed: false, updated_at: Date.now() + 1 }));
      const row = store.getTask("t1")!;
      expect(row.status).toBe("pending");
      expect(deriveTaskStatus(row.status, false)).toBe("pending");
    } finally {
      store.close();
    }
  });

  it("done wins over reviewer alive", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-done-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { status: "done", card_id: "card-a", actor: "human" }));
      const row = store.getTask("t1")!;
      expect(deriveTaskStatus(row.status, true)).toBe("done");
    } finally {
      store.close();
    }
  });

  it("human hold + live card → diverged stamped at write", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-hold-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { actor: "agent" }));
      store.upsertTask(base("t1", { card_id: "card-a", actor: "agent", statusProposed: false, updated_at: Date.now() + 1 }));
      store.upsertTask(base("t1", { status: "pending", card_id: "card-a", actor: "human", updated_at: Date.now() + 1 }));
      const row = store.getTask("t1")!;
      expect(row.status).toBe("pending");
      expect(row.diverged_status).toBe("pending");
      expect(row.diverged_actor).toBe("human");
      expect(deriveTaskStatus(row.status, true)).toBe("running");
    } finally {
      store.close();
    }
  });

  it("failed + implementer link with applyStatusDespiteHold → pending stored", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-reopen-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { status: "failed", actor: "app" }));
      store.upsertTask(base("t1", { status: "pending", actor: "human", updated_at: Date.now() + 1 }));
      store.upsertTask(
        base("t1", {
          status: "pending",
          card_id: "card-b",
          actor: "agent",
          applyStatusDespiteHold: true,
          updated_at: Date.now() + 2,
        }),
      );
      const row = store.getTask("t1")!;
      expect(row.status).toBe("pending");
      expect(row.card_id).toBe("card-b");
      expect(deriveTaskStatus(row.status, true)).toBe("running");
    } finally {
      store.close();
    }
  });

  it("closeSprint freezes derived status via isCardAlive", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-derive-sprint-"));
    const store = openStore(dir);
    try {
      store.upsertBoard(makeBoard("default"));
      store.openSprint("default");
      store.upsertTask(base("t1", { actor: "agent" }));
      store.upsertTask(base("t1", { card_id: "card-live", actor: "agent", statusProposed: false, updated_at: Date.now() + 1 }));
      const result = store.closeSprint("default", (id) => id === "card-live");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const snapshot = JSON.parse(result.closed.snapshot_json!) as { id: string; status: string }[];
      expect(snapshot.find((s) => s.id === "t1")?.status).toBe("running");
    } finally {
      store.close();
    }
  });
});
