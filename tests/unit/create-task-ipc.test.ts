import { describe, expect, it, vi } from "vitest";
import { createTaskFull } from "../../src/main/create-task-ipc";
import type { TaskRow } from "../../src/main/store";

describe("createTaskFull", () => {
  it("persists the create_task contract for a human create", () => {
    const rows: TaskRow[] = [];
    const result = createTaskFull(
      {
        boardId: "board-1",
        prompt: "Terminal scroll\n\nFEEDBACK",
        purpose: "fix",
        territory: ["src/a.ts", "shared:src/App.tsx (coord)"],
        gates: ["npm test", { cmd: "npx vitest run", exclusive: "machine" }],
        reportSchema: ["filesChanged", "gatesOutput"],
        allowCommit: false,
        review: "wanted",
        provider: "claude",
        deps: ["dep-1"],
        maxRetries: 2,
        fallbackProviders: ["antigravity"],
        cwd: "/tmp/proj",
        suggestedOrder: 0,
      },
      {
        boardExists: (id) => id === "board-1",
        upsertTask: (row) => {
          rows.push(row);
          return row;
        },
      },
    );
    expect(result).toEqual({ ok: true, taskId: expect.any(String) });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.board_id).toBe("board-1");
    expect(row.prompt).toContain("Terminal scroll");
    expect(row.purpose).toBe("fix");
    expect(row.review).toBe("wanted");
    expect(row.provider).toBe("claude");
    expect(row.allow_commit).toBe(0);
    expect(row.actor).toBe("human");
    expect(row.territory_json).toContain("src/a.ts");
    expect(row.gates_json).toContain("vitest");
    expect(row.report_schema_json).toContain("filesChanged");
    expect(row.deps_json).toContain("dep-1");
    expect(row.max_retries).toBe(2);
    expect(row.fallback_providers_json).toContain("antigravity");
    expect(row.cwd).toBe("/tmp/proj");
    expect(row.suggested_order).toBe(0);
  });

  it("refuses empty prompt and missing board", () => {
    const upsert = vi.fn();
    expect(
      createTaskFull({ boardId: "b", prompt: "  " }, { boardExists: () => true, upsertTask: upsert }),
    ).toMatchObject({ ok: false, field: "prompt" });
    expect(
      createTaskFull({ boardId: "missing", prompt: "x" }, { boardExists: () => false, upsertTask: upsert }),
    ).toMatchObject({ ok: false, field: "boardId" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses unknown purpose and review", () => {
    expect(
      createTaskFull(
        { boardId: "b", prompt: "x", purpose: "nope" },
        { boardExists: () => true, upsertTask: vi.fn() },
      ),
    ).toMatchObject({ ok: false, field: "purpose" });
    expect(
      createTaskFull(
        { boardId: "b", prompt: "x", review: "owner" },
        { boardExists: () => true, upsertTask: vi.fn() },
      ),
    ).toMatchObject({ ok: false, field: "review" });
  });
});
