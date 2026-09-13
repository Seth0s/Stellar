import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type TaskRow } from "../../src/main/store";

describe("store.ts: tasks.purpose write-once", () => {
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

  it("create without purpose persists NULL — absence is NORMAL, not a default", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-purpose-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t-empty"));
      expect(store.getTask("t-empty")!.purpose).toBeNull();
    } finally {
      store.close();
    }
  });

  it("create with a valid purpose persists it", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-purpose-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t-inv", { purpose: "investigate" }));
      expect(store.getTask("t-inv")!.purpose).toBe("investigate");
    } finally {
      store.close();
    }
  });

  it("create with an invalid purpose persists NULL — never invents implement", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-purpose-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t-bad", { purpose: "INVESTIGAÇÃO" }));
      expect(store.getTask("t-bad")!.purpose).toBeNull();
      store.upsertTask(base("t-review", { purpose: "review" }));
      expect(store.getTask("t-review")!.purpose).toBeNull();
    } finally {
      store.close();
    }
  });

  it("a later upsert cannot change purpose (update_task / drag / retry)", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-purpose-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t1", { purpose: "investigate" }));
      store.upsertTask(base("t1", { purpose: "implement", status: "running", updated_at: Date.now() + 1 }));
      const row = store.getTask("t1")!;
      expect(row.purpose).toBe("investigate");
      expect(row.status).toBe("running");
    } finally {
      store.close();
    }
  });

  it("update that omits purpose keeps the created value", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-purpose-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("t2", { purpose: "measure" }));
      const { purpose: _dropped, ...without } = base("t2", { status: "done", updated_at: Date.now() + 1 });
      store.upsertTask(without);
      expect(store.getTask("t2")!.purpose).toBe("measure");
    } finally {
      store.close();
    }
  });

  it("getTaskPurposesByIds normalizes and skips unknown ids", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-purpose-"));
    const store = openStore(dir);
    try {
      store.upsertTask(base("a", { purpose: "fix" }));
      store.upsertTask(base("b"));
      const map = store.getTaskPurposesByIds(["a", "b", "missing"]);
      expect(map).toEqual({ a: "fix", b: null });
    } finally {
      store.close();
    }
  });
});
