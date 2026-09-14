import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type CardRow, type TaskRow } from "../../src/main/store";

/**
 * Task contract columns + participation profile on task_cards.
 * Additive beside linked_at (007dda0) — nullable, no backfill.
 */

function baseTask(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
  const now = Date.now();
  return {
    id,
    prompt: "work",
    provider: "cursor",
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

function baseCard(id: string): CardRow {
  return {
    id,
    board_id: "default",
    kind: "terminal",
    provider: "cursor",
    cwd: "/tmp",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    resume_id: null,
    model: "gpt",
    effort: "high",
    system_prompt: null,
    group_id: null,
    label: null,
    updated_at: Date.now(),
    messages_json: null,
    archived_at: null,
  };
}

describe("store: task contract + participation profile", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("persists contract fields and clears them with null", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-contract-"));
    const store = openStore(dir);
    try {
      store.upsertTask(
        baseTask("t1", {
          territory_json: JSON.stringify(["src/a.ts"]),
          gates_json: JSON.stringify(["npm test"]),
          allow_commit: 0,
          report_schema_json: JSON.stringify(["separation"]),
        }),
      );
      const row = store.getTask("t1")!;
      expect(row.territory_json).toBe(JSON.stringify(["src/a.ts"]));
      expect(row.gates_json).toBe(JSON.stringify(["npm test"]));
      expect(row.allow_commit).toBe(0);
      expect(row.report_schema_json).toBe(JSON.stringify(["separation"]));

      store.upsertTask(
        baseTask("t1", {
          territory_json: null,
          gates_json: null,
          allow_commit: null,
          report_schema_json: null,
          updated_at: Date.now() + 1,
        }),
      );
      const cleared = store.getTask("t1")!;
      expect(cleared.territory_json).toBeNull();
      expect(cleared.allow_commit).toBeNull();
    } finally {
      store.close();
    }
  });

  it("records provider/model/effort on linkTaskCard beside linked_at", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-profile-"));
    const store = openStore(dir);
    try {
      store.upsertCard(baseCard("10"));
      store.upsertTask(baseTask("t2"));
      store.linkTaskCard("t2", "10", "implementer", {
        provider: "cursor",
        model: "gpt",
        effort: "high",
      });
      const cards = store.getTaskCards("t2");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.provider).toBe("cursor");
      expect(cards[0]!.model).toBe("gpt");
      expect(cards[0]!.effort).toBe("high");
      expect(cards[0]!.linked_at).toEqual(expect.any(Number));
    } finally {
      store.close();
    }
  });

  it("COALESCE on re-link keeps prior profile when new profile fields are null", () => {
    dir = mkdtempSync(join(tmpdir(), "stellar-profile-coalesce-"));
    const store = openStore(dir);
    try {
      store.upsertCard(baseCard("11"));
      store.upsertTask(baseTask("t3"));
      store.linkTaskCard("t3", "11", "implementer", {
        provider: "claude",
        model: "opus",
        effort: "medium",
      });
      store.linkTaskCard("t3", "11", "reviewer");
      const cards = store.getTaskCards("t3");
      expect(cards[0]!.role).toBe("reviewer");
      expect(cards[0]!.provider).toBe("claude");
      expect(cards[0]!.model).toBe("opus");
      expect(cards[0]!.effort).toBe("medium");
    } finally {
      store.close();
    }
  });
});
